import 'server-only';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeAudit, writeSettingTx } from '@/modules/hdc/api';
import { cleanUserText } from '@/modules/hdc/pref';
import { ensureAgentBot } from '@/modules/hdu/api/agent-bots';
import { generateTokenValue, hashToken, normalizeCidr, tokenLast4 } from '../agent/auth';
import { HdaError } from '../error';
import {
  AGENT_ALLOWED_IPS_MAX,
  AGENT_CALLS_PAGE,
  AGENT_DAILY_LIMIT_DEFAULT,
  AGENT_DAILY_LIMIT_MAX,
  AGENT_READ_TOOLS,
  AGENT_SETTINGS,
  AGENT_TOKEN_MAX_DAYS,
  AGENT_TOKEN_NAME_MAX,
  AGENT_TOOLS,
  type AgentCallStatus,
  type AgentTool,
  TELEGRAM_CHAT_ID,
} from '../pref';
import { type AgentObjectRef, agentTokens, agentToolCalls as toolCalls } from '../schema';

// Модуль hda, слой api: токены AI-сотрудников для экрана "AI-сотрудники" (веха M8b, задача 3; FR-AGT-02, 09,
// FR-ADM-13, 8.12; план M8b, решения 10, 16, 24, 27, 28, 29). Читает только администратор портала; выпуск, правка,
// отзыв, отметка "для событий" и чат команды требуют входа не старше 15 минут (ТЗ 14.3). Каждое изменение пишется в
// журнал аудита той же транзакцией. Значение токена возвращает только выпуск, один раз: в базе SHA-256 и 4 знака.

export { HdaError, isHdaError } from '../error';
export { AGENT_CALLS_PAGE, AGENT_DAILY_LIMIT_DEFAULT, AGENT_DAILY_LIMIT_MAX, AGENT_READ_TOOLS, AGENT_TOKEN_MAX_DAYS, AGENT_TOOLS, AGENT_WRITE_TOOLS, type AgentTool } from '../pref';

export type AgentTokenState = 'active' | 'expired' | 'revoked';
export type AgentTokenView = {
  tokenId: string;
  name: string;
  /** Последние 4 знака значения: узнать токен. */
  last4: string;
  tools: AgentTool[];
  readTools: number;
  writeTools: number;
  allowedIps: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  dailyLimit: number;
  isEventParent: boolean;
  state: AgentTokenState;
  /** Вызовов токена и его токенов запуска за последние 24 часа. */
  callsToday: number;
  createdOn: Date;
  modifiedOn: Date;
};
export type AgentCallView = { callId: string; tool: string; status: AgentCallStatus; objectRefs: AgentObjectRef[]; durationMs: number; createdOn: Date; isRun: boolean };

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
}

function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  return parsed.data;
}

const DAY_MS = 86_400_000;
const READ_SET: ReadonlySet<string> = new Set(AGENT_READ_TOOLS);

/** Срок: дата "действует до" (начало дня UTC), позже текущего момента и не дальше 365 суток (решение 10). */
const expiresField = z.iso
  .date()
  .transform((value) => new Date(`${value}T00:00:00Z`))
  .refine((date) => date.getTime() > Date.now() && date.getTime() <= Date.now() + AGENT_TOKEN_MAX_DAYS * DAY_MS);
const fields = {
  tools: z
    .array(z.enum(AGENT_TOOLS))
    .min(1)
    .max(AGENT_TOOLS.length)
    .transform((list) => AGENT_TOOLS.filter((tool) => list.includes(tool))),
  allowedIps: z
    .array(z.string().max(64))
    .min(1)
    .max(AGENT_ALLOWED_IPS_MAX)
    .transform((list) => list.map(normalizeCidr))
    .refine((list): list is string[] => list.every((cidr) => cidr !== null))
    .transform((list) => [...new Set(list as string[])]),
  expiresAt: expiresField,
  dailyLimit: z.number().int().min(1).max(AGENT_DAILY_LIMIT_MAX),
};
const issueInput = z.strictObject({
  name: z.string().overwrite(cleanUserText).trim().min(1).max(AGENT_TOKEN_NAME_MAX),
  ...fields,
  dailyLimit: fields.dailyLimit.default(AGENT_DAILY_LIMIT_DEFAULT),
});
const updateInput = z.strictObject({ tokenId: z.uuid(), ...fields });
const idInput = z.strictObject({ tokenId: z.uuid() });
const parentInput = z.strictObject({ tokenId: z.uuid().nullable() });
const callsInput = z.strictObject({ tokenId: z.uuid(), cursor: z.uuid().nullable().optional() });
const chatInput = z.strictObject({ chatId: z.string().max(40).trim().refine((value) => value === '' || TELEGRAM_CHAT_ID.test(value)) });

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Основной токен под блокировкой. Токены запуска на экран не выходят: для экрана их нет. */
async function lockMainTx(tx: Tx, tokenId: string) {
  const [row] = await tx
    .select()
    .from(agentTokens)
    .where(and(eq(agentTokens.tokenId, tokenId), isNull(agentTokens.parentTokenId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

// Колонка внешней строки названа полностью: без имени таблицы "token_id" внутри подзапроса значило бы x.token_id, и
// счётчик складывал вызовы всех токенов (находка браузерного теста задачи 11).
const callsToday = sql<number>`(
  select count(*)::int from hda_agent_tool_calls c
   where c.created_on > now() - interval '24 hours'
     and c.token_id in (select x.token_id from hda_agent_tokens x where x.token_id = "hda_agent_tokens"."token_id" or x.parent_token_id = "hda_agent_tokens"."token_id"))`;

function view(row: typeof agentTokens.$inferSelect & { callsToday: number }, now: Date): AgentTokenView {
  const tools = row.tools as AgentTool[];
  return {
    tokenId: row.tokenId,
    name: row.name,
    last4: row.tokenLast4,
    tools,
    readTools: tools.filter((tool) => READ_SET.has(tool)).length,
    writeTools: tools.filter((tool) => !READ_SET.has(tool)).length,
    allowedIps: row.allowedIps,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    dailyLimit: row.dailyLimit,
    isEventParent: row.isEventParent,
    state: row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : 'active',
    callsToday: Number(row.callsToday),
    createdOn: row.createdOn,
    modifiedOn: row.modifiedOn,
  };
}

/** Основные токены: действующие и истёкшие по имени, отозванные в конце. */
export async function listAgentTokens(ctx: StaffContext): Promise<AgentTokenView[]> {
  requireAdmin(ctx);
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select({ token: agentTokens, callsToday })
      .from(agentTokens)
      .where(isNull(agentTokens.parentTokenId))
      .orderBy(sql`${agentTokens.revokedAt} is not null`, asc(agentTokens.name), desc(agentTokens.tokenId)),
  );
  const now = new Date();
  return rows.map((row) => view({ ...row.token, callsToday: row.callsToday }, now));
}

/** Основной токен по идентификатору. Нет такого, токен запуска или негодный идентификатор: null. */
export async function readAgentToken(ctx: StaffContext, tokenId: unknown): Promise<AgentTokenView | null> {
  requireAdmin(ctx);
  const id = z.uuid().safeParse(tokenId);
  if (!id.success) return null;
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select({ token: agentTokens, callsToday })
      .from(agentTokens)
      .where(and(eq(agentTokens.tokenId, id.data), isNull(agentTokens.parentTokenId)))
      .limit(1),
  );
  const row = rows[0];
  return row ? view({ ...row.token, callsToday: row.callsToday }, new Date()) : null;
}

/**
 * Выпустить основной токен. Учётная запись agent_bot для имени создаётся при первом выпуске (своей транзакцией модуля
 * hdu: таблицы идентичности под hub_auth); токен и запись журнала одной транзакцией. Значение возвращается один раз.
 */
export async function issueAgentToken(ctx: StaffContext, input: unknown): Promise<{ tokenId: string; value: string }> {
  requireFreshAdmin(ctx);
  const data = parse(issueInput, input);
  const { userId } = await ensureAgentBot(data.name);
  const value = generateTokenValue();
  const tokenId = await withActor(ctx.actor, async (tx) => {
    const [row] = await tx
      .insert(agentTokens)
      .values({
        name: data.name,
        staffUserId: userId,
        tokenHash: hashToken(value),
        tokenLast4: tokenLast4(value),
        tools: data.tools,
        allowedIps: data.allowedIps,
        expiresAt: data.expiresAt,
        dailyLimit: data.dailyLimit,
      })
      .returning({ tokenId: agentTokens.tokenId });
    if (!row) throw new Error('токен агента не записан');
    await writeAudit(tx, {
      action: 'agent.token_issued',
      objectType: 'agent_token',
      objectId: row.tokenId,
      diff: { name: data.name, tools: data.tools, allowedIps: data.allowedIps, expiresAt: isoDay(data.expiresAt), dailyLimit: data.dailyLimit },
    });
    return row.tokenId;
  });
  return { tokenId, value };
}

/** Изменить перечень инструментов, адреса, суточный предел и срок действующего или истёкшего токена. */
export async function updateAgentToken(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(updateInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await lockMainTx(tx, data.tokenId);
    if (!row || row.revokedAt) throw new HdaError('not_found');
    const diff: Record<string, unknown> = {};
    if (JSON.stringify(row.tools) !== JSON.stringify(data.tools)) diff.tools = data.tools;
    if (JSON.stringify(row.allowedIps) !== JSON.stringify(data.allowedIps)) diff.allowedIps = data.allowedIps;
    if (row.dailyLimit !== data.dailyLimit) diff.dailyLimit = data.dailyLimit;
    if (row.expiresAt.getTime() !== data.expiresAt.getTime()) diff.expiresAt = isoDay(data.expiresAt);
    if (Object.keys(diff).length === 0) return;
    await tx
      .update(agentTokens)
      .set({ tools: data.tools, allowedIps: data.allowedIps, dailyLimit: data.dailyLimit, expiresAt: data.expiresAt })
      .where(eq(agentTokens.tokenId, data.tokenId));
    await writeAudit(tx, { action: 'agent.token_changed', objectType: 'agent_token', objectId: data.tokenId, diff: { name: row.name, ...diff } });
  });
}

/**
 * Отозвать токен одним действием (решение 29): revoked_at той же транзакцией, что запись журнала, вместе с его
 * токенами запуска. Следующий запрос с токеном получает отказ; запрос, начатый до отзыва, теряет данные на следующей
 * транзакции (app.agent_token_active). Повторный отзыв ничего не меняет.
 */
export async function revokeAgentToken(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const { tokenId } = parse(idInput, input);
  await withActor(ctx.actor, async (tx) => {
    const row = await lockMainTx(tx, tokenId);
    if (!row) throw new HdaError('not_found');
    if (row.revokedAt) return;
    await tx.update(agentTokens).set({ revokedAt: sql`now()`, isEventParent: false }).where(eq(agentTokens.tokenId, tokenId));
    const runs = await tx
      .update(agentTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(agentTokens.parentTokenId, tokenId), isNull(agentTokens.revokedAt)))
      .returning({ tokenId: agentTokens.tokenId });
    await writeAudit(tx, { action: 'agent.token_revoked', objectType: 'agent_token', objectId: tokenId, diff: { name: row.name, runRevoked: runs.length } });
  });
}

/**
 * Токен "для событий" (решение 27): от него система выпускает токены запуска в событиях по обращениям. Не больше
 * одного; null снимает отметку. Отмечается только действующий основной токен.
 */
export async function setEventParent(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const { tokenId } = parse(parentInput, input);
  await withActor(ctx.actor, async (tx) => {
    let name: string | null = null;
    if (tokenId) {
      const row = await lockMainTx(tx, tokenId);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) throw new HdaError('not_found');
      name = row.name;
    }
    await tx
      .update(agentTokens)
      .set({ isEventParent: false })
      .where(and(eq(agentTokens.isEventParent, true), isNull(agentTokens.revokedAt), tokenId ? ne(agentTokens.tokenId, tokenId) : undefined));
    if (tokenId) await tx.update(agentTokens).set({ isEventParent: true }).where(eq(agentTokens.tokenId, tokenId));
    await writeAudit(tx, { action: 'agent.event_parent_set', objectType: 'agent_token', objectId: tokenId ?? undefined, diff: { name } });
  });
}

/** Журнал вызовов токена и его токенов запуска, новые сверху, по 50. Аргументов и ответов в журнале нет. */
export async function agentToolCalls(ctx: StaffContext, input: unknown): Promise<{ items: AgentCallView[]; nextCursor: string | null }> {
  requireAdmin(ctx);
  const { tokenId, cursor } = parse(callsInput, input);
  return withActor(ctx.actor, async (tx) => {
    const own = await tx
      .select({ tokenId: agentTokens.tokenId, parentTokenId: agentTokens.parentTokenId })
      .from(agentTokens)
      .where(or(eq(agentTokens.tokenId, tokenId), eq(agentTokens.parentTokenId, tokenId)));
    if (!own.some((row) => row.tokenId === tokenId && row.parentTokenId === null)) throw new HdaError('not_found');
    // По индексу hda_agent_tool_calls_i1 (токен, вызов): идентификатор uuidv7 растёт со временем.
    const rows = await tx
      .select({
        callId: toolCalls.callId,
        tokenId: toolCalls.tokenId,
        tool: toolCalls.tool,
        status: toolCalls.status,
        objectRefs: toolCalls.objectRefs,
        durationMs: toolCalls.durationMs,
        createdOn: toolCalls.createdOn,
      })
      .from(toolCalls)
      .where(and(inArray(toolCalls.tokenId, own.map((row) => row.tokenId)), cursor ? lt(toolCalls.callId, cursor) : undefined))
      .orderBy(desc(toolCalls.callId))
      .limit(AGENT_CALLS_PAGE + 1);
    const page = rows.slice(0, AGENT_CALLS_PAGE);
    return {
      items: page.map(({ tokenId: callToken, ...row }) => ({ ...row, isRun: callToken !== tokenId })),
      nextCursor: rows.length > AGENT_CALLS_PAGE ? (page.at(-1)?.callId ?? null) : null,
    };
  });
}

/** Служебный чат команды для сообщений по сводкам (решение 24). Нет настройки: null. */
export async function readTeamChat(ctx: StaffContext): Promise<string | null> {
  requireAdmin(ctx);
  // Строка из цифр ложится в jsonb числом (драйвер передаёт строку как есть): читаются оба вида, как у чата дежурных.
  const stored = await readSetting(AGENT_SETTINGS.teamChatId);
  const value = typeof stored === 'number' ? String(stored) : stored;
  return typeof value === 'string' && TELEGRAM_CHAT_ID.test(value) ? value : null;
}

/** Задать или убрать (пустая строка) чат команды. Запись журнала делает writeSettingTx. */
export async function saveTeamChat(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const { chatId } = parse(chatInput, input);
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, AGENT_SETTINGS.teamChatId, chatId === '' ? null : chatId));
}
