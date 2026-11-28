import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { type DomainEvent, FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeSettingTx } from '@/modules/hdc/api';
import { moduleCodesTx } from '@/modules/hdr/api';
import { agentEventTicketsTx } from '@/modules/hdt/api/agent-events';
import { agentEventOrgsTx } from '@/modules/hdu/api/automation';
import { type AgentEventKind, type AgentEventSource, type AgentEventTicket, agentEventBody, agentEventHeaders } from '../agent/events';
import { issueTicketRunTokenTx, revokeTicketRunTokenTx, type RunToken } from '../agent/run-token';
import { createHttpAgentEventSender } from '../agent/sender/http';
import type { AgentEventSender } from '../agent/sender/types';
import { createProblemFromSignature, problemNumbersTx, signaturesWithProblemTx } from '@/modules/hdp/api/agent-drafts';
import { PROBLEM_WRITER_ROLES } from '@/modules/hdp/pref';
import { signatureOrgCountsTx, signatureTicketIdsTx } from '@/modules/hdt/api/known-problems';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { spikeDecision } from '../agent/spikes';
import { HdaError } from '../error';
import { AGENT_SETTINGS, SPIKE_DEFAULTS, SPIKE_LIMITS } from '../pref';
import { agentEvents, agentTokens, agentToolCalls, signatureSpikes } from '../schema';

// Модуль hda, слой api: всплеск сигнатуры (веха M8b, задача 8; FR-AGT-11, 10.5; план M8b, решение 25). Задача
// agent.spikes раз в 5 минут: сигнатура у обращений не меньше чем agent.spike_org_count разных организаций клиентов
// за agent.spike_window_minutes, нет активной проблемы или черновика с ней, не было всплеска за 24 часа: строка
// hda_signature_spikes. Считаются все организации, а не только с AI-обработкой: это счётчик. Сотрудники видят
// всплески блоком на странице известных проблем; "Создать известную проблему" работает и без агента.

export type SpikeSettings = { orgCount: number; windowMinutes: number };

const countField = z.number().int().min(SPIKE_LIMITS.orgCount.min).max(SPIKE_LIMITS.orgCount.max);
const windowField = z.number().int().min(SPIKE_LIMITS.windowMinutes.min).max(SPIKE_LIMITS.windowMinutes.max);

/** Настройки всплеска: нет строки или значение неверно, значение по умолчанию. */
export async function spikeSettings(): Promise<SpikeSettings> {
  const count = countField.safeParse(await readSetting(AGENT_SETTINGS.spikeOrgCount));
  const window = windowField.safeParse(await readSetting(AGENT_SETTINGS.spikeWindowMinutes));
  return { orgCount: count.success ? count.data : SPIKE_DEFAULTS.orgCount, windowMinutes: window.success ? window.data : SPIKE_DEFAULTS.windowMinutes };
}

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
}

export async function spikeSettingsView(ctx: StaffContext): Promise<SpikeSettings> {
  requireAdmin(ctx);
  return spikeSettings();
}

const settingsInput = z.strictObject({ orgCount: z.coerce.number().pipe(countField), windowMinutes: z.coerce.number().pipe(windowField) });

/** Порог и окно всплеска: только администратор со входом не старше 15 минут, журнал аудита той же транзакцией. */
export async function saveSpikeSettings(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const current = await spikeSettings();
  await withActor(ctx.actor, async (tx) => {
    if (current.orgCount !== parsed.data.orgCount) await writeSettingTx(tx, AGENT_SETTINGS.spikeOrgCount, parsed.data.orgCount);
    if (current.windowMinutes !== parsed.data.windowMinutes) await writeSettingTx(tx, AGENT_SETTINGS.spikeWindowMinutes, parsed.data.windowMinutes);
  });
}

export type DetectedSpike = { spikeId: string; signature: string; orgCount: number; ticketCount: number; windowMinutes: number; detectedOn: Date };

/** Поиск всплесков одной транзакцией системы. Возвращает найденные: задача событий (задача 9) ставит по ним события. */
export async function detectSpikesTx(tx: Tx, now: Date, settings: SpikeSettings): Promise<DetectedSpike[]> {
  const since = new Date(now.getTime() - settings.windowMinutes * 60_000);
  const counts = await signatureOrgCountsTx(tx, { since, until: now, minOrgs: settings.orgCount, excludeOrgId: SERVICE_ORG_ID });
  if (counts.length === 0) return [];
  const withProblem = await signaturesWithProblemTx(
    tx,
    counts.map((c) => c.signature),
  );
  const recent = await tx
    .select({ signature: signatureSpikes.signature, detectedOn: sql<Date>`max(${signatureSpikes.detectedOn})` })
    .from(signatureSpikes)
    .where(and(inArray(signatureSpikes.signature, counts.map((c) => c.signature)), gte(signatureSpikes.detectedOn, new Date(now.getTime() - 2 * 86_400_000))))
    .groupBy(signatureSpikes.signature);
  const last = new Map(recent.map((row) => [row.signature, new Date(row.detectedOn)]));
  const detected: DetectedSpike[] = [];
  for (const count of counts) {
    const decision = spikeDecision({ orgCount: count.orgCount, threshold: settings.orgCount, activeProblem: withProblem.has(count.signature), lastSpikeOn: last.get(count.signature) ?? null, now });
    if (decision !== 'spike') continue;
    const [row] = await tx
      .insert(signatureSpikes)
      .values({ signature: count.signature, orgCount: count.orgCount, ticketCount: count.ticketCount, windowMinutes: settings.windowMinutes, detectedOn: now })
      .returning({ spikeId: signatureSpikes.spikeId });
    const spike = { spikeId: row!.spikeId, signature: count.signature, orgCount: count.orgCount, ticketCount: count.ticketCount, windowMinutes: settings.windowMinutes, detectedOn: now };
    // Событие агенту той же транзакцией (решение 26); без AGENT_WEBHOOK_URL не ставится.
    await enqueueSpikeEventTx(tx, spike);
    detected.push(spike);
  }
  return detected;
}

/** Задача agent.spikes. */
export async function runSpikeDetection(system: SystemActor, now: Date = new Date()): Promise<{ detected: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  const settings = await spikeSettings();
  const detected = await withActor(system, (tx) => detectSpikesTx(tx, now, settings));
  return { detected: detected.length };
}

export type SpikeView = { spikeId: string; signature: string; orgCount: number; ticketCount: number; windowMinutes: number; detectedOn: Date; problemNumber: number | null };

/** Всплески за 7 суток для блока "Всплески сигнатур": все сотрудники. */
export async function listSpikes(ctx: StaffContext): Promise<SpikeView[]> {
  if (ctx.actor.type !== 'staff') throw new HdaError('forbidden');
  return withActor(ctx.actor, async (tx) => {
    const rows = await tx
      .select()
      .from(signatureSpikes)
      .where(gte(signatureSpikes.detectedOn, new Date(Date.now() - 7 * 86_400_000)))
      .orderBy(desc(signatureSpikes.detectedOn))
      .limit(20);
    const numbers = await problemNumbersTx(
      tx,
      rows.flatMap((row) => (row.problemId ? [row.problemId] : [])),
    );
    return rows.map((row) => ({
      spikeId: row.spikeId,
      signature: row.signature,
      orgCount: row.orgCount,
      ticketCount: row.ticketCount,
      windowMinutes: row.windowMinutes,
      detectedOn: row.detectedOn,
      problemNumber: row.problemId ? (numbers.get(row.problemId) ?? null) : null,
    }));
  });
}

const fromSpikeInput = z.strictObject({ spikeId: z.uuid(), internalTitle: z.string().trim().min(1).max(200) });

/** "Создать известную проблему" по всплеску: роль ведения проблем, обращения окна привязываются, всплеск ссылается на проблему. */
export async function createProblemFromSpike(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  if (ctx.actor.type !== 'staff' || !(PROBLEM_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
  const parsed = fromSpikeInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const actor = ctx.actor;
  const spike = await withActor(actor, async (tx) => {
    const [row] = await tx.select().from(signatureSpikes).where(eq(signatureSpikes.spikeId, parsed.data.spikeId)).limit(1);
    if (!row || row.problemId) return null;
    const ticketIds = await signatureTicketIdsTx(tx, { signature: row.signature, since: new Date(row.detectedOn.getTime() - row.windowMinutes * 60_000), until: row.detectedOn });
    return { row, ticketIds };
  });
  if (!spike) throw new HdaError('not_found');
  const problem = await createProblemFromSignature(ctx, { internalTitle: parsed.data.internalTitle, signature: spike.row.signature, ticketIds: spike.ticketIds });
  await withActor(actor, (tx) => tx.update(signatureSpikes).set({ problemId: problem.problemId }).where(eq(signatureSpikes.spikeId, spike.row.spikeId)));
  return { number: problem.number };
}

// --- События для AI-сотрудника (задача 9; FR-AGT-08, 10, 12; план M8b, решения 26, 27) ---

/** Настройки приёма событий: адрес, секрет и отправитель. Без адреса события агенту не ставятся. */
export type AgentEventSettings = { url: string; secret: string; sender: AgentEventSender };

let eventsOverride: AgentEventSettings | null | undefined;
let realSender: { url: string; sender: AgentEventSender } | undefined;

/** Подмена настроек событий для тестов: объект, null (нет адреса) или undefined (окружение). */
export function setAgentEventsForTests(settings: AgentEventSettings | null | undefined): void {
  eventsOverride = settings;
}

export function agentEventSettings(): AgentEventSettings | null {
  if (eventsOverride !== undefined) return eventsOverride;
  const env = getEnv();
  if (!env.AGENT_WEBHOOK_URL || !env.AGENT_WEBHOOK_SECRET) return null;
  if (realSender?.url !== env.AGENT_WEBHOOK_URL) realSender = { url: env.AGENT_WEBHOOK_URL, sender: createHttpAgentEventSender(env.HUB_URL) };
  return { url: env.AGENT_WEBHOOK_URL, secret: env.AGENT_WEBHOOK_SECRET, sender: realSender.sender };
}

const TICKET_KINDS: ReadonlySet<string> = new Set(['ai_handoff', 'line_transferred', 'sla_breached', 'code_analysis_requested']);
/** Виды, которые несут токен запуска по обращению (решение 27; анализ по коду: веха M8c, решение 19). */
const RUN_TOKEN_KINDS: ReadonlySet<string> = new Set(['ai_handoff', 'line_transferred', 'code_analysis_requested']);
const RETRY_MINUTES = [1, 5, 15, 60] as const;
const MAX_ATTEMPTS = 5;
/** Пока событие отправляется, строка не берётся повторно столько минут. */
const LEASE_MINUTES = 5;

async function ticketSourceTx(tx: Tx, ticketIds: readonly string[]): Promise<Map<string, AgentEventTicket>> {
  const facts = await agentEventTicketsTx(tx, ticketIds);
  const orgs = await agentEventOrgsTx(
    tx,
    facts.map((f) => f.orgId),
  );
  const modules = await moduleCodesTx(
    tx,
    facts.flatMap((f) => (f.moduleId ? [f.moduleId] : [])),
  );
  const out = new Map<string, AgentEventTicket>();
  for (const f of facts) {
    const org = orgs.get(f.orgId);
    if (!org) continue;
    out.set(f.ticketId, { id: f.ticketId, number: f.number, priority: f.priority, queue: f.queue, module: f.moduleId ? (modules.get(f.moduleId) ?? null) : null, orgId: f.orgId, orgCategory: org.category });
  }
  return out;
}

async function enqueueTx(tx: Tx, row: { kind: AgentEventKind; ticketId?: string; spikeId?: string; source: AgentEventSource }): Promise<void> {
  const body = agentEventBody(row.source);
  await tx.insert(agentEvents).values({ eventId: row.source.eventId, kind: row.kind, ticketId: row.ticketId ?? null, spikeId: row.spikeId ?? null, body });
}

/**
 * Обработчик разбора событий предметной области: передача помощником, передача на вторую линию, нарушение SLA ставят
 * строку очереди. Точка сохранения: сбой здесь не откатывает событие, правила и другие обработчики.
 */
export async function handleAgentEvent(tx: Tx, event: DomainEvent): Promise<void> {
  if (!TICKET_KINDS.has(event.kind) || !agentEventSettings()) return;
  try {
    await tx.transaction(async (point) => {
      const ticket = (await ticketSourceTx(point, [event.ticketId])).get(event.ticketId);
      // Организация без AI-обработки и "Неопознанные": события нет (решение 6).
      if (!ticket) return;
      const payload = event.payload as { reason?: unknown; deadline?: unknown; requestId?: unknown };
      const source: AgentEventSource =
        event.kind === 'code_analysis_requested'
          ? { eventId: randomUUID(), kind: 'code_analysis_requested', occurredOn: event.createdOn, ticket, analysisRequestId: String(payload.requestId ?? '') }
          : {
              eventId: randomUUID(),
              kind: event.kind as 'ai_handoff' | 'line_transferred' | 'sla_breached',
              occurredOn: event.createdOn,
              ticket,
              reason: typeof payload.reason === 'string' ? payload.reason : null,
              deadline: typeof payload.deadline === 'string' ? payload.deadline : null,
            };
      await enqueueTx(point, { kind: event.kind as AgentEventKind, ticketId: event.ticketId, source });
    });
  } catch (error) {
    logEvent('error', 'agent.event_enqueue_failed', { eventId: event.eventId, kind: event.kind, error: error instanceof Error ? error.name : 'ошибка' });
  }
}

/** Событие всплеска в транзакции задачи всплесков: номера обращений окна только из организаций, видимых агенту. */
export async function enqueueSpikeEventTx(tx: Tx, spike: DetectedSpike): Promise<void> {
  if (!agentEventSettings()) return;
  const ids = await signatureTicketIdsTx(tx, { signature: spike.signature, since: new Date(spike.detectedOn.getTime() - spike.windowMinutes * 60_000), until: spike.detectedOn });
  const visible = [...(await ticketSourceTx(tx, ids)).values()].map((t) => t.number).sort((a, b) => a - b);
  await enqueueTx(tx, {
    kind: 'signature_spike',
    spikeId: spike.spikeId,
    source: {
      eventId: randomUUID(),
      kind: 'signature_spike',
      occurredOn: spike.detectedOn,
      spike: { signature: spike.signature, orgCount: spike.orgCount, ticketCount: spike.ticketCount, windowMinutes: spike.windowMinutes, ticketNumbers: visible.slice(0, 50) },
    },
  });
}

type Claimed = { eventId: string; kind: AgentEventKind; ticketId: string | null; body: Record<string, unknown>; attempts: number; runToken: RunToken | null };

/** Захват одной строки: срок захвата, при необходимости новый токен запуска. Значение токена только в памяти. */
async function claimTx(system: SystemActor, now: Date): Promise<Claimed | null> {
  return withActor(system, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.status, 'queued'), lte(agentEvents.nextAttemptOn, now)))
      .orderBy(agentEvents.createdOn)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    let runToken: RunToken | null = null;
    if (RUN_TOKEN_KINDS.has(row.kind) && row.ticketId) {
      const [parent] = await tx
        .select({ tokenId: agentTokens.tokenId })
        .from(agentTokens)
        .where(and(eq(agentTokens.isEventParent, true), isNull(agentTokens.revokedAt), isNull(agentTokens.parentTokenId), gt(agentTokens.expiresAt, now)))
        .limit(1);
      if (parent)
        runToken = await issueTicketRunTokenTx(tx, system, { parentTokenId: parent.tokenId, ticketId: row.ticketId, eventId: row.eventId, ...(row.kind === 'code_analysis_requested' ? { purpose: 'code_analysis' as const } : {}) }, now);
    }
    await tx
      .update(agentEvents)
      .set({ nextAttemptOn: new Date(now.getTime() + LEASE_MINUTES * 60_000), runTokenId: runToken?.tokenId ?? row.runTokenId })
      .where(eq(agentEvents.eventId, row.eventId));
    return { eventId: row.eventId, kind: row.kind as AgentEventKind, ticketId: row.ticketId, body: row.body, attempts: row.attempts, runToken };
  });
}

/** Бюджет времени одного запуска отправки: задача идёт раз в минуту, следующий запуск не должен догнать этот. */
export const AGENT_DISPATCH_BUDGET_MS = 50_000;

/**
 * Отправка очереди: задача agent.events_dispatch раз в минуту. До пяти попыток с паузами 1, 5, 15, 60 минут.
 * Запуск ограничен бюджетом времени и останавливается, если адрес не ответил (проверка качества, Q4): адрес один на
 * все события, и 50 событий по 10 секунд тайм-аута держали бы задачу больше восьми минут. Остальные события ждут
 * следующей минуты без потраченной попытки. Ответ с кодом ошибки отправку не останавливает: адрес отвечает.
 */
export async function dispatchAgentEvents(system: SystemActor, opts: { now?: Date; batch?: number; budgetMs?: number; clock?: () => number } = {}): Promise<{ sent: number; failed: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  const settings = agentEventSettings();
  const result = { sent: 0, failed: 0 };
  if (!settings) return result;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? AGENT_DISPATCH_BUDGET_MS);
  for (let i = 0; i < (opts.batch ?? 50); i += 1) {
    if (clock() >= deadline) {
      logEvent('warn', 'agent.events_budget', { sent: result.sent, failed: result.failed });
      break;
    }
    const now = opts.now ?? new Date();
    const claimed = await claimTx(system, now);
    if (!claimed) break;
    const body = claimed.runToken
      ? { ...claimed.body, run_token: { value: claimed.runToken.value, tools: [...claimed.runToken.tools], expires_on: claimed.runToken.expiresAt.toISOString() } }
      : claimed.body;
    const raw = JSON.stringify(body);
    const outcome = await settings.sender.send({ url: settings.url, body: raw, headers: agentEventHeaders({ secret: settings.secret, rawBody: raw, eventId: claimed.eventId, kind: claimed.kind, now }) });
    await withActor(system, async (tx) => {
      if (outcome.ok) {
        await tx.update(agentEvents).set({ status: 'sent', sentOn: new Date(), lastStatus: outcome.status }).where(eq(agentEvents.eventId, claimed.eventId));
        return;
      }
      // Токен запуска неотправленного события не должен жить: агент его не получил.
      if (claimed.runToken) await revokeTicketRunTokenTx(tx, system, { tokenId: claimed.runToken.tokenId });
      const attempts = claimed.attempts + 1;
      const done = attempts >= MAX_ATTEMPTS;
      await tx
        .update(agentEvents)
        .set({
          attempts,
          status: done ? 'failed' : 'queued',
          lastStatus: outcome.status,
          nextAttemptOn: new Date(Date.now() + (RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] ?? 60) * 60_000),
        })
        .where(eq(agentEvents.eventId, claimed.eventId));
    });
    if (outcome.ok) result.sent += 1;
    else result.failed += 1;
    logEvent(outcome.ok ? 'info' : 'warn', 'agent.event_sent', { eventId: claimed.eventId, kind: claimed.kind, ok: outcome.ok, status: outcome.status });
    // Адрес не ответил (тайм-аут, обрыв сети): следующие события ждали бы столько же.
    if (!outcome.ok && outcome.status === null) {
      logEvent('warn', 'agent.events_unreachable', { eventId: claimed.eventId });
      break;
    }
  }
  return result;
}

/** Ночная очистка: журнал вызовов старше 365 суток, события старше 30 суток, токены запуска, истёкшие больше 7 суток назад. */
export async function cleanupAgentData(system: SystemActor, now: Date = new Date()): Promise<{ calls: number; events: number; runTokens: number }> {
  if (system.type !== 'system') throw new HdaError('forbidden');
  return withActor(system, async (tx) => {
    const calls = await tx.delete(agentToolCalls).where(lt(agentToolCalls.createdOn, new Date(now.getTime() - 365 * 86_400_000))).returning({ id: agentToolCalls.callId });
    const events = await tx.delete(agentEvents).where(lt(agentEvents.createdOn, new Date(now.getTime() - 30 * 86_400_000))).returning({ id: agentEvents.eventId });
    // Токен со строками журнала вызовов или событий держит внешний ключ: он уйдёт после их очистки.
    const runTokens = await tx
      .delete(agentTokens)
      .where(
        and(
          isNotNull(agentTokens.parentTokenId),
          lt(agentTokens.expiresAt, new Date(now.getTime() - 7 * 86_400_000)),
          sql`not exists (select 1 from hda_agent_tool_calls c where c.token_id = ${agentTokens.tokenId})`,
          sql`not exists (select 1 from hda_agent_events e where e.run_token_id = ${agentTokens.tokenId})`,
        ),
      )
      .returning({ id: agentTokens.tokenId });
    return { calls: calls.length, events: events.length, runTokens: runTokens.length };
  });
}
