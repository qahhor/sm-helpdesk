import 'server-only';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { type DomainEvent, writeAudit } from '@/modules/hdc/api';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { lockRuleTicketTx, ruleHistoryTx, silenceOfTx, silentTicketsTx } from '@/modules/hdt/api/automation';
import { TICKET_STATUSES, type TicketStatus } from '@/modules/hdt/pref';
import { staffRoster } from '@/modules/hdu/api/automation';
import { evaluate, type TicketSnapshot } from '../evaluate';
import { LOOP_LIMIT, LOOP_WINDOW_MIN, RULE_EVENTS, type RuleEventKind, type RunResult } from '../pref';
import { type ActionDone, ruleRuns, rules } from '../schema';
import { executeAction, type Roster } from './actions';
import { enabledRulesTx, type RuleRecord, ruleGateTx } from './rules';
import { snapshotsTx, snapshotTx } from './snapshot';

// Модуль hdw, слой core: применение правил (FR-AUTO-06, 07, 09; план M8, задача 3, решения 3-5).
//
// Событие обращения разбирает задача automation.process: одна транзакция системы на событие. Правила события идут
// по порядку; условия проверяются на снимке обращения, который перечитывается после каждого сработавшего правила
// (следующее правило видит изменения предыдущего); флаг "остановить" прекращает разбор следующих правил. Событие,
// порождённое правилом, не разбирается вовсе, а всё, что пишут действия, помечено как порождённое правилом:
// правила не запускают правила.
//
// Каждое срабатывание пишет строку hdw_rule_runs, одну внутреннюю запись истории обращения и запись журнала аудита
// в той же транзакции. Одиннадцатое срабатывание правила на обращении за час выключает правило.

/** Состояние одного запуска разбора: счётчики для журнала процесса и сотрудники, прочитанные один раз. */
export type RuleRun = { now: () => Date; roster: Roster; applied: number; failed: number; loops: number };

export function createRuleRun(opts: { now?: () => Date } = {}): RuleRun {
  let roster: ReturnType<Roster> | undefined;
  return {
    now: opts.now ?? (() => new Date()),
    // Сотрудники читаются другим подключением (роль hub_auth) один раз на запуск и только если нужны действию.
    roster: () => (roster ??= staffRoster()),
    applied: 0,
    failed: 0,
    loops: 0,
  };
}

type Source = { eventId: string | null; marker: string | null };

const RULE_EVENT_SET: ReadonlySet<string> = new Set(RULE_EVENTS);

/** Итог по действиям: все выполнены, часть или ни одного. */
const resultOf = (done: readonly ActionDone[]): RunResult => (done.every((item) => item.ok) ? 'applied' : done.some((item) => item.ok) ? 'partial' : 'failed');

/**
 * Защита от зацикливания (FR-AUTO-07, решение 4): правило уже сработало на обращении LOOP_LIMIT раз за час.
 * Срабатывание не выполняется и записывается как skipped_loop, правило выключается с причиной loop, запись в журнал
 * аудита, действующим администраторам уведомление в портале.
 */
async function stopLoopTx(tx: Tx, rule: RuleRecord, snapshot: TicketSnapshot, source: Source, run: RuleRun): Promise<void> {
  await tx.insert(ruleRuns).values({ orgId: snapshot.orgId, ruleId: rule.ruleId, ticketId: snapshot.ticketId, eventId: source.eventId, result: 'skipped_loop', actionsDone: [], marker: source.marker });
  await tx.update(rules).set({ isEnabled: false, disabledReason: 'loop' }).where(eq(rules.ruleId, rule.ruleId));
  await writeAudit(tx, { action: 'rule.disabled_loop', objectType: 'rule', objectId: rule.ruleId, diff: { name: rule.name, ticketId: snapshot.ticketId, number: snapshot.number, limit: LOOP_LIMIT } });
  for (const member of (await run.roster()).filter((item) => item.role === 'admin'))
    await notifyTx(tx, { userId: member.userId, kind: 'rule_disabled', payload: { rule: rule.name } });
  run.loops++;
  logEvent('warn', 'automation.rule_disabled_loop', { ruleId: rule.ruleId, ticketId: snapshot.ticketId });
}

/**
 * Применяет правило к обращению в транзакции системы: условия уже проверены на snapshot. Возвращает итог.
 * Строка обращения блокируется заново перед действиями: действия работают с текущим состоянием.
 */
async function applyRuleTx(tx: Tx, rule: RuleRecord, snapshot: TicketSnapshot, source: Source, run: RuleRun): Promise<RunResult> {
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(ruleRuns)
    .where(
      and(
        eq(ruleRuns.ticketId, snapshot.ticketId),
        eq(ruleRuns.ruleId, rule.ruleId),
        inArray(ruleRuns.result, ['applied', 'partial']),
        gt(ruleRuns.createdOn, sql`now() - make_interval(mins => ${LOOP_WINDOW_MIN})`),
      ),
    );
  if ((recent?.n ?? 0) >= LOOP_LIMIT) {
    await stopLoopTx(tx, rule, snapshot, source, run);
    return 'skipped_loop';
  }
  let ticket = await lockRuleTicketTx(tx, snapshot.ticketId);
  if (!ticket) return 'failed';
  const done: ActionDone[] = [];
  for (const action of rule.actions) {
    const { error, ...item } = await executeAction({ tx, ticket, snapshot, rule, now: run.now(), roster: run.roster }, action);
    done.push(item);
    if (error) {
      // Действие откатилось в точке сохранения: состояние обращения перечитывается из базы.
      const fresh = await lockRuleTicketTx(tx, snapshot.ticketId);
      if (!fresh) break;
      ticket = fresh;
    }
  }
  const result = resultOf(done);
  await tx.insert(ruleRuns).values({ orgId: snapshot.orgId, ruleId: rule.ruleId, ticketId: snapshot.ticketId, eventId: source.eventId, result, actionsDone: done, marker: source.marker });
  if (result === 'failed') {
    run.failed++;
    return result;
  }
  // Одна внутренняя запись истории на срабатывание (FR-AUTO-09): клиент её не видит.
  await ruleHistoryTx(tx, ticket, { ruleId: rule.ruleId, ruleName: rule.name, actions: done });
  await writeAudit(tx, { action: 'rule.applied', objectType: 'ticket', objectId: snapshot.ticketId, orgId: snapshot.orgId, diff: { ruleId: rule.ruleId, ruleName: rule.name, result, actions: done } });
  run.applied++;
  return result;
}

/**
 * Обработчик события для processEvents: работает в транзакции события вместе с отметкой разбора. Событие,
 * порождённое правилом или макросом, пропускается целиком (FR-AUTO-07). Правила применяются только к обращению
 * события.
 */
export async function handleRuleEventTx(tx: Tx, event: DomainEvent, run: RuleRun): Promise<void> {
  if (event.isByRule || !RULE_EVENT_SET.has(event.kind) || event.kind === 'no_activity') return;
  const list = await enabledRulesTx(tx, event.kind as RuleEventKind);
  if (list.length === 0) return;
  // Блокировка обращения на всё событие: правила и сотрудник не меняют его одновременно.
  const locked = await lockRuleTicketTx(tx, event.ticketId);
  if (!locked || locked.orgId !== event.orgId) return;
  let snapshot = await snapshotTx(tx, event.ticketId, run.now());
  for (const rule of list) {
    if (!snapshot) return;
    if (!rule.isValid) {
      logEvent('warn', 'automation.rule_invalid', { ruleId: rule.ruleId });
      continue;
    }
    if (!evaluate(rule, snapshot, run.now())) continue;
    const result = await applyRuleTx(tx, rule, snapshot, { eventId: event.eventId, marker: null }, run);
    if (result === 'skipped_loop') continue;
    // Следующее правило видит изменения этого.
    snapshot = await snapshotTx(tx, event.ticketId, run.now());
    if (rule.isStop) break;
  }
}

// --- Событие "нет активности" (решение 5 плана M8) ---

const HOUR_MS = 3_600_000;
const OPEN_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter((status) => status !== 'resolved' && status !== 'closed');
/** Сколько обращений читает один шаг и сколько одно правило просматривает за запуск: остальные возьмёт следующая минута. */
const SILENT_BATCH = 200;
const SILENT_PER_RUN = 2000;
/**
 * Где правило остановилось в прошлый запуск: следующий продолжает с этого места, обращения дальше первой пачки не
 * ждут вечно. Память процесса: после перезапуска просмотр начинается сначала, срабатывания от этого не повторяются.
 */
const cursors = (globalThis as typeof globalThis & { __hubSilentCursors?: Map<string, string | null> }).__hubSilentCursors ??= new Map<string, string | null>();

/**
 * Статусы, в которых правило ищет молчащие обращения: решённые и закрытые не берутся, если условие правила "статус
 * равен" не называет статусы само. Отбор в базе грубый, точное решение принимают условия правила на снимке.
 */
export function silentStatuses(rule: Pick<RuleRecord, 'conditions'>): TicketStatus[] {
  const named = rule.conditions.items.flatMap((item) => (item.field === 'status' && item.op === 'is' ? item.values : []));
  return named.length > 0 ? [...new Set(named)] : [...OPEN_STATUSES];
}

/**
 * Граница включения: молчание должно достичь N часов не раньше включения правила, то есть начаться не раньше, чем за
 * N часов до него. Обращения, молчавшие N часов ещё до включения, правило не трогает до нового сообщения.
 * Правило без момента включения (включено поставкой) границы не имеет.
 */
const silenceFloor = (enabledOn: Date | null, hours: number): Date | null => (enabledOn ? new Date(enabledOn.getTime() - hours * HOUR_MS) : null);

export type NoActivityOptions = { now?: Date; batch?: number; perRun?: number; stopped?: () => boolean; run?: RuleRun };

/**
 * Событие "нет активности N часов": вызывается задачей automation.process раз в минуту, не на каждое событие.
 * Для каждого включённого правила берутся обращения, у которых с последнего сообщения человека прошло N часов и у
 * которых нет срабатывания этого правила с отметкой этого молчания. Условия проверяются на снимке; подошедшее
 * обращение применяется своей транзакцией под блокировкой строки, с перепроверкой молчания. Отметка и уникальный
 * индекс hdw_rule_runs_u1 дают одно срабатывание на молчание и при двух процессах; новое сообщение взводит заново.
 * Молчание, достигшее N часов до включения правила, не срабатывает (silenceFloor).
 */
export async function runNoActivityTx(actor: SystemActor, opts: NoActivityOptions = {}): Promise<{ checked: number; applied: number; failed: number }> {
  if (actor.type !== 'system') throw new Error('Правила применяет только система');
  const now = opts.now ?? new Date();
  const run = opts.run ?? createRuleRun({ now: () => now });
  const batch = Math.max(1, opts.batch ?? SILENT_BATCH);
  const perRun = Math.max(batch, opts.perRun ?? SILENT_PER_RUN);
  const before = { applied: run.applied, failed: run.failed };
  let checked = 0;
  const list = await withActor(actor, (tx) => enabledRulesTx(tx, 'no_activity'));
  for (const rule of list) {
    if (!rule.isValid || rule.hours === null) continue;
    const hours = rule.hours;
    const cutoff = new Date(now.getTime() - hours * HOUR_MS);
    const statuses = silentStatuses(rule);
    let after = cursors.get(rule.ruleId) ?? null;
    let seen = 0;
    while (seen < perRun && opts.stopped?.() !== true) {
      // Чтение пачки одной транзакцией: молчащие обращения, уже отмеченные срабатывания, снимки остальных.
      const page = await withActor(actor, async (tx) => {
        const silent = await silentTicketsTx(tx, { cutoff, notBefore: silenceFloor(rule.enabledOn, hours), statuses, after, limit: batch });
        if (silent.length === 0) return { size: 0, last: null, due: [] };
        const fired = await tx
          .select({ ticketId: ruleRuns.ticketId, marker: ruleRuns.marker })
          .from(ruleRuns)
          .where(and(eq(ruleRuns.ruleId, rule.ruleId), inArray(ruleRuns.ticketId, silent.map((item) => item.ticketId)), inArray(ruleRuns.marker, [...new Set(silent.map((item) => item.marker))])));
        const firedKeys = new Set(fired.map((row) => `${row.ticketId}|${row.marker}`));
        const waiting = silent.filter((item) => !firedKeys.has(`${item.ticketId}|${item.marker}`));
        const snapshots = await snapshotsTx(tx, waiting.map((item) => item.ticketId), now);
        const due = waiting.filter((item) => {
          const snapshot = snapshots.byId.get(item.ticketId);
          return snapshot !== undefined && evaluate(rule, snapshot, now);
        });
        return { size: silent.length, last: silent.at(-1)?.ticketId ?? null, due };
      });
      seen += page.size;
      checked += page.size;
      for (const item of page.due) {
        if (opts.stopped?.() === true) break;
        try {
          await withActor(actor, async (tx) => {
            // Занятую строку (сотрудник или второй процесс) этот запуск пропускает: её возьмёт следующая минута.
            const ticket = await lockRuleTicketTx(tx, item.ticketId, { skipLocked: true });
            if (!ticket) return;
            const gate = await ruleGateTx(tx, rule.ruleId);
            if (!gate.isEnabled) return;
            const silence = await silenceOfTx(tx, item.ticketId);
            if (!silence || silence.marker !== item.marker || silence.since.getTime() > cutoff.getTime()) return;
            const floor = silenceFloor(gate.enabledOn, hours);
            if (floor && silence.since.getTime() < floor.getTime()) return;
            const [already] = await tx.select({ runId: ruleRuns.runId }).from(ruleRuns).where(and(eq(ruleRuns.ruleId, rule.ruleId), eq(ruleRuns.ticketId, item.ticketId), eq(ruleRuns.marker, item.marker))).limit(1);
            if (already) return;
            const snapshot = await snapshotTx(tx, item.ticketId, now);
            if (!snapshot || !statuses.includes(snapshot.status) || !evaluate(rule, snapshot, now)) return;
            await applyRuleTx(tx, rule, snapshot, { eventId: null, marker: item.marker }, run);
          });
        } catch (error) {
          // Второй процесс успел первым (уникальная отметка) или сбой базы: транзакция обращения откатилась целиком.
          logEvent('warn', 'automation.no_activity_failed', { ruleId: rule.ruleId, ticketId: item.ticketId, error: error instanceof Error ? error.name : 'ошибка' });
        }
      }
      after = page.size < batch ? null : page.last;
      if (after === null) break;
    }
    cursors.set(rule.ruleId, after);
  }
  return { checked, applied: run.applied - before.applied, failed: run.failed - before.failed };
}
