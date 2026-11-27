import 'server-only';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { emitEventTx, type StaffContext, wakeAutomation, writeAudit } from '@/modules/hdc/api';
import { ticketCodeFactsTx } from '@/modules/hdt/api/solution-source';
import { agentEventOrgsTx } from '@/modules/hdu/api/automation';
import { HdaError } from '../error';
import { CODE_ANALYSIS_RULE_COOLDOWN_HOURS, CODE_ANALYSIS_TIMEOUT_MINUTES, CODE_READER_ROLES, type CodeAnalysisStatus } from '../pref';
import { codeAnalysisRequests } from '../schema';

// Модуль hda, слой api: "Разобрать по коду" (веха M8c, задача 7; ТЗ 7.22 FR-CODE-08, 09, 10, 7.21 FR-AGT-08; план
// M8c, решения 18, 21, 22). Сотрудник agent_l2, care или admin (или правило автоматизации от системы) запрашивает анализ:
// строка запроса со сроком 10 минут, событие предметной области code_analysis_requested и журнал аудита одной
// транзакцией. Разбор событий ставит событие AI-сотруднику с токеном запуска на это обращение. Организация без
// AI-обработки и "Неопознанные": отказ ai_disabled, агенту обращение не выдаётся. Пока запрос ждёт, повтор возвращает
// его же. Ответ агента приходит инструментом submit_code_analysis; без ответа за 10 минут задача ставит timeout.
// Работа с обращением от анализа не зависит.

export type CodeAnalysisState = {
  requestId: string;
  status: CodeAnalysisStatus;
  requestedOn: Date;
  dueOn: Date;
  finishedOn: Date | null;
  noteMessageId: string | null;
};

const numberInput = z.strictObject({ number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

function requireReader(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff' || !(CODE_READER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  return parsed.data;
}

function stateOf(row: typeof codeAnalysisRequests.$inferSelect, now: Date = new Date()): CodeAnalysisState {
  // Срок вышел, а задача ещё не прошла: показываем "анализ не выполнен" сразу (FR-CODE-10).
  const status: CodeAnalysisStatus = row.status === 'pending' && row.dueOn <= now ? 'timeout' : row.status;
  return { requestId: row.requestId, status, requestedOn: row.createdOn, dueOn: row.dueOn, finishedOn: row.finishedOn, noteMessageId: row.noteMessageId };
}

async function latestTx(tx: Tx, ticketId: string) {
  const [row] = await tx.select().from(codeAnalysisRequests).where(eq(codeAnalysisRequests.ticketId, ticketId)).orderBy(desc(codeAnalysisRequests.createdOn)).limit(1);
  return row ?? null;
}

/** Ошибка уникальности: второй ожидающий запрос по обращению (гонка двух нажатий). */
const isUniqueViolation = (error: unknown) => (error as { code?: unknown }).code === '23505' || (error as { cause?: { code?: unknown } }).cause?.code === '23505';

/**
 * Запрос в транзакции вызывающего: проверка организации, ожидающий запрос или новый с событием и аудитом. Точка
 * сохранения держит гонку двух нажатий: второй читает запрос первого.
 */
async function requestTx(
  tx: Tx,
  input: { ticketId: string; orgId: string; requestedBy: string | null; ruleId?: string },
): Promise<{ outcome: 'requested' | 'pending'; row: typeof codeAnalysisRequests.$inferSelect } | 'ai_disabled' | 'cooldown'> {
  if (!(await agentEventOrgsTx(tx, [input.orgId])).has(input.orgId)) return 'ai_disabled';
  const existing = await latestTx(tx, input.ticketId);
  if (existing?.status === 'pending') {
    // Срок вышел, а минутная задача ещё не прошла (или упала): запрос истекает той же транзакцией, затем новый
    // (независимая проверка M8c, находка I4).
    const expired = await tx
      .update(codeAnalysisRequests)
      .set({ status: 'timeout', finishedOn: sql`now()` })
      .where(and(eq(codeAnalysisRequests.requestId, existing.requestId), eq(codeAnalysisRequests.status, 'pending'), lte(codeAnalysisRequests.dueOn, sql`now()`)))
      .returning({ id: codeAnalysisRequests.requestId });
    if (expired.length === 0) return { outcome: 'pending', row: existing };
    await writeAudit(tx, { action: 'code.analysis_timed_out', objectType: 'code_analysis', objectId: existing.requestId, orgId: input.orgId, diff: { by: 'request' } });
    existing.status = 'timeout';
  }
  // Правило не запрашивает анализ того же обращения чаще раза в 6 часов (находка M7, решение 0134): конец прошлого
  // запроса для истёкшего его срок, для выполненного момент ответа. Кнопку сотрудника пауза не держит.
  if (input.ruleId && existing && (existing.status === 'done' || existing.status === 'timeout')) {
    const ended = existing.status === 'timeout' ? existing.dueOn : (existing.finishedOn ?? existing.dueOn);
    if (Date.now() - ended.getTime() < CODE_ANALYSIS_RULE_COOLDOWN_HOURS * 3_600_000) return 'cooldown';
  }
  try {
    const row = await tx.transaction(async (point) => {
      const [created] = await point
        .insert(codeAnalysisRequests)
        .values({
          orgId: input.orgId,
          ticketId: input.ticketId,
          requestedBy: input.requestedBy,
          source: input.requestedBy ? 'staff' : 'rule',
          dueOn: sql`now() + make_interval(mins => ${CODE_ANALYSIS_TIMEOUT_MINUTES})`,
        })
        .returning();
      return created!;
    });
    await emitEventTx(tx, { orgId: input.orgId, ticketId: input.ticketId, kind: 'code_analysis_requested', payload: { requestId: row.requestId }, ...(input.ruleId ? { byRule: true } : {}) });
    await writeAudit(tx, { action: 'code.analysis_requested', objectType: 'code_analysis', objectId: row.requestId, orgId: input.orgId, diff: { source: row.source, ...(input.ruleId ? { rule: input.ruleId } : {}) } });
    return { outcome: 'requested', row };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await latestTx(tx, input.ticketId);
    if (!raced) throw error;
    return { outcome: 'pending', row: raced };
  }
}

/** "Разобрать по коду" (FR-CODE-08): agent_l2, care, admin. Повтор, пока запрос ждёт, возвращает его же. */
export async function requestCodeAnalysis(ctx: StaffContext, input: unknown): Promise<CodeAnalysisState> {
  requireReader(ctx);
  const { number } = parse(numberInput, input);
  const result = await withActor(ctx.actor, async (tx) => {
    const facts = await ticketCodeFactsTx(tx, number);
    if (!facts) throw new HdaError('not_found');
    return requestTx(tx, { ticketId: facts.ticketId, orgId: facts.orgId, requestedBy: ctx.actor.userId });
  });
  if (result === 'ai_disabled') throw new HdaError('ai_disabled');
  // Пауза только у правила: у запроса кнопкой её нет.
  if (result === 'cooldown') throw new HdaError('invalid_input');
  if (result.outcome === 'requested') await wakeAutomation();
  return stateOf(result.row);
}

/**
 * Запрос правилом автоматизации (FR-CODE-09) в транзакции правила от системы: те же проверки, без пользователя.
 * Итог для истории правила: запрошен, уже ждёт, организация без AI-обработки.
 */
export async function requestCodeAnalysisBySystemTx(tx: Tx, input: { ticketId: string; orgId: string; ruleId: string }): Promise<'requested' | 'pending' | 'ai_disabled' | 'cooldown'> {
  const result = await requestTx(tx, { ticketId: input.ticketId, orgId: input.orgId, requestedBy: null, ruleId: input.ruleId });
  return typeof result === 'string' ? result : result.outcome;
}

/** Последний запрос анализа обращения для блока "Что известно по коду". Нет запроса: null. */
export async function codeAnalysisState(ctx: StaffContext, input: unknown): Promise<CodeAnalysisState | null> {
  requireReader(ctx);
  const { number } = parse(numberInput, input);
  return withActor(ctx.actor, async (tx) => {
    const facts = await ticketCodeFactsTx(tx, number);
    if (!facts) throw new HdaError('not_found');
    const row = await latestTx(tx, facts.ticketId);
    return row ? stateOf(row) : null;
  });
}

/** Можно ли запросить анализ по обращению: организация с AI-обработкой и не "Неопознанные". */
export async function canRequestCodeAnalysis(ctx: StaffContext, input: unknown): Promise<boolean> {
  if (ctx?.actor?.type !== 'staff' || !(CODE_READER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) return false;
  const { number } = parse(numberInput, input);
  return withActor(ctx.actor, async (tx) => {
    const facts = await ticketCodeFactsTx(tx, number);
    return facts ? (await agentEventOrgsTx(tx, [facts.orgId])).has(facts.orgId) : false;
  });
}

/** Задача code.analysis_timeouts раз в минуту: ожидающие запросы, срок которых вышел, становятся timeout (FR-CODE-10). */
export async function markAnalysisTimeouts(system: SystemActor, now: Date = new Date()): Promise<{ timedOut: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  // Каждое истечение пишет журнал аудита той же транзакцией (независимая проверка M8c, находка M1).
  const rows = await withActor(system, async (tx) => {
    const expired = await tx
      .update(codeAnalysisRequests)
      .set({ status: 'timeout', finishedOn: now })
      .where(and(eq(codeAnalysisRequests.status, 'pending'), lte(codeAnalysisRequests.dueOn, now)))
      .returning({ id: codeAnalysisRequests.requestId, orgId: codeAnalysisRequests.orgId });
    for (const row of expired) await writeAudit(tx, { action: 'code.analysis_timed_out', objectType: 'code_analysis', objectId: row.id, orgId: row.orgId, diff: { by: 'schedule' } });
    return expired;
  });
  return { timedOut: rows.length };
}
