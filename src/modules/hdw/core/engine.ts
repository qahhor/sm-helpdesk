import 'server-only';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { type DomainEvent, EVENT_MAX_ATTEMPTS, writeAudit } from '@/modules/hdc/api';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { lockRuleTicketTx, ruleHistoryTx, silenceOfTx, silentTicketsTx } from '@/modules/hdt/api/automation';
import { TICKET_STATUSES, type TicketStatus } from '@/modules/hdt/pref';
import { staffRoster } from '@/modules/hdu/api/automation';
import { evaluate, type TicketSnapshot } from '../evaluate';
import { LOOP_LIMIT, LOOP_ORGS_TO_DISABLE, LOOP_WINDOW_MIN, RULE_EVENTS, type RuleEventKind, type RunResult } from '../pref';
import { type ActionDone, ruleRuns, rules } from '../schema';
import { isBuiltinAction } from '../rule-schema';
import { executeAction, type Roster } from './actions';
import { enabledRulesTx, type RuleRecord, ruleGateTx } from './rules';
import { snapshotsTx, snapshotTx } from './snapshot';
import { withActorForTicket } from '@/modules/hdt/api/notice-identity';

// Модуль hdw, слой core: применение правил (FR-AUTO-06, 07, 09; план M8, задача 3, решения 3-5).
//
// Событие обращения разбирает задача automation.process: одна транзакция системы на событие. Правила события идут
// по порядку; условия проверяются на снимке обращения, который перечитывается после каждого сработавшего правила
// (следующее правило видит изменения предыдущего); флаг "остановить" прекращает разбор следующих правил. Событие,
// порождённое правилом, правилам администратора не достаётся, а всё, что пишут действия, помечено как порождённое
// правилом: правила не запускают правила. Исключение одно: уведомления предустановленных правил (FR-AUTO-12)
// срабатывают и на событие, порождённое правилом или макросом. Это прежние встроенные уведомления портала (дежурным
// о P1 при любом поднятии приоритета): они обращение не меняют и цепочку породить не могут.
//
// Каждое срабатывание пишет строку hdw_rule_runs, одну внутреннюю запись истории обращения и запись журнала аудита
// в той же транзакции (уведомление предустановленного правила историю обращения не пополняет: см. applyRuleTx).
// Одиннадцатое срабатывание правила на обращении за час, которое что-то сделало, не выполняется: правило
// приостановлено на этом обращении, пока не освободится окно. Выключается правило целиком, только когда предел за
// час достигнут на обращениях трёх организаций (loopLimitTx).

/** Состояние одного запуска разбора: счётчики для журнала процесса и сотрудники, прочитанные один раз. */
export type RuleRun = { now: () => Date; roster: Roster; applied: number; failed: number; /** Правил выключено защитой от зацикливания. */ loops: number; /** Срабатываний пропущено: правило приостановлено на обращении. */ paused: number };

export function createRuleRun(opts: { now?: () => Date } = {}): RuleRun {
  let roster: ReturnType<Roster> | undefined;
  return {
    now: opts.now ?? (() => new Date()),
    // Сотрудники читаются другим подключением (роль hub_auth) один раз на запуск и только если нужны действию.
    // Отказ чтения не запоминается: следующее действие и следующее событие читают заново.
    roster: () => {
      const pending = (roster ??= staffRoster());
      pending.catch(() => {
        if (roster === pending) roster = undefined;
      });
      return pending;
    },
    applied: 0,
    failed: 0,
    loops: 0,
    paused: 0,
  };
}

/** kind: вид разбираемого события. У предустановленного правила он бывает не его собственным событием (extraEvents). */
type Source = { eventId: string | null; marker: string | null; payload?: Record<string, unknown>; kind?: RuleEventKind; lastAttempt: boolean };

const RULE_EVENT_SET: ReadonlySet<string> = new Set(RULE_EVENTS);

/** Итог по действиям: все выполнены, часть или ни одного. */
const resultOf = (done: readonly ActionDone[]): RunResult => (done.every((item) => item.ok) ? 'applied' : done.some((item) => item.ok) ? 'partial' : 'failed');

/**
 * Защита от зацикливания (FR-AUTO-07, решение 4; проверка вехи M8, находка S1): правило уже сработало на обращении
 * LOOP_LIMIT раз за час. Срабатывание не выполняется и записывается как skipped_loop: на этом обращении правило
 * приостановлено, пока окно не освободится. На остальных обращениях оно работает: события, порождённые правилами,
 * правил администратора не запускают, поэтому счётчик двигают только люди, и одиннадцать ответов одного клиента за
 * час не должны выключать правило для всех организаций.
 *
 * Администраторы получают уведомление "правило приостановлено на обращении" один раз на правило в час. Целиком
 * правило выключается (причина loop, запись в журнал аудита, уведомление), только когда предел за час достигнут на
 * обращениях LOOP_ORGS_TO_DISABLE разных организаций: это уже не один настойчивый клиент, а ошибка в правиле.
 * Пропуски до последнего включения правила не считаются: иначе включённое заново правило выключалось бы сразу.
 */
async function loopLimitTx(tx: Tx, rule: RuleRecord, snapshot: TicketSnapshot, source: Source, run: RuleRun): Promise<void> {
  // Два события разных обращений не решают о паузе и выключении одновременно по устаревшим числам.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hdw.loop:${rule.ruleId}`}))`);
  const [gate] = await tx.select({ isEnabled: rules.isEnabled, enabledOn: rules.enabledOn }).from(rules).where(eq(rules.ruleId, rule.ruleId)).limit(1);
  const [before] = await tx
    .select({ n: sql<number>`count(*)::int`, otherOrgs: sql<number>`count(distinct ${ruleRuns.orgId}) filter (where ${ruleRuns.orgId} <> ${snapshot.orgId})::int` })
    .from(ruleRuns)
    .where(
      and(
        eq(ruleRuns.ruleId, rule.ruleId),
        eq(ruleRuns.result, 'skipped_loop'),
        gt(ruleRuns.createdOn, sql`now() - make_interval(mins => ${LOOP_WINDOW_MIN})`),
        gate?.enabledOn ? gt(ruleRuns.createdOn, gate.enabledOn) : undefined,
      ),
    );
  await tx.insert(ruleRuns).values({ orgId: snapshot.orgId, ruleId: rule.ruleId, ticketId: snapshot.ticketId, eventId: source.eventId, result: 'skipped_loop', actionsDone: [], marker: source.marker });
  const diff = { name: rule.name, ticketId: snapshot.ticketId, number: snapshot.number, limit: LOOP_LIMIT };
  if ((before?.otherOrgs ?? 0) + 1 >= LOOP_ORGS_TO_DISABLE) {
    // Правило уже выключил другой процесс или администратор: второй записи и уведомления не нужно.
    if (gate?.isEnabled !== true) return;
    await tx.update(rules).set({ isEnabled: false, disabledReason: 'loop' }).where(eq(rules.ruleId, rule.ruleId));
    await writeAudit(tx, { action: 'rule.disabled_loop', objectType: 'rule', objectId: rule.ruleId, diff });
    for (const member of (await run.roster()).filter((item) => item.role === 'admin'))
      await notifyTx(tx, { userId: member.userId, kind: 'rule_disabled', payload: { rule: rule.name } });
    run.loops++;
    logEvent('warn', 'automation.rule_disabled_loop', { ruleId: rule.ruleId, ticketId: snapshot.ticketId });
    return;
  }
  run.paused++;
  // Первая пауза правила за час: запись в журнал и уведомление. Следующие (то же или другое обращение) только пишут skipped_loop.
  if ((before?.n ?? 0) > 0) return;
  await writeAudit(tx, { action: 'rule.paused_loop', objectType: 'rule', objectId: rule.ruleId, diff });
  for (const member of (await run.roster()).filter((item) => item.role === 'admin'))
    await notifyTx(tx, { userId: member.userId, kind: 'rule_paused', ticketId: snapshot.ticketId, orgId: snapshot.orgId, payload: { rule: rule.name, number: snapshot.number } });
  logEvent('warn', 'automation.rule_paused_loop', { ruleId: rule.ruleId, ticketId: snapshot.ticketId });
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
        // Считаются срабатывания, которые что-то сделали. Срабатывание, где менять было нечего (тег уже стоит,
        // дежурные о P1 уже извещены), цепочку не продолжает: иначе приоритет, который десять раз за час подняли до
        // P1 и опустили, выключил бы уведомление дежурных для всех обращений.
        sql`jsonb_path_exists(${ruleRuns.actionsDone}, '$[*] ? (@.ok == true && !(exists(@.unchanged)))')`,
      ),
    );
  if ((recent?.n ?? 0) >= LOOP_LIMIT) {
    await loopLimitTx(tx, rule, snapshot, source, run);
    return 'skipped_loop';
  }
  let ticket = await lockRuleTicketTx(tx, snapshot.ticketId);
  if (!ticket) return 'failed';
  const done: ActionDone[] = [];
  for (const action of rule.actions) {
    const { error, ...item } = await executeAction(
      { tx, ticket, snapshot, rule: { ruleId: rule.ruleId, name: rule.name, event: source.kind ?? rule.event }, eventId: source.eventId, eventPayload: source.payload ?? null, now: run.now(), roster: run.roster, lastAttempt: source.lastAttempt },
      action,
    );
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
  // Одна внутренняя запись истории на срабатывание (FR-AUTO-09): клиент её не видит. Срабатывание предустановленного
  // правила, в котором выполнялись только его уведомления, историю обращения не пополняет: эти уведомления и раньше
  // не оставляли в ней записи, обращение они не меняют. След остаётся в журнале срабатываний и в журнале аудита.
  const onlyBuiltinNotices = rule.pcode !== null && done.every((item) => isBuiltinAction(item));
  if (!onlyBuiltinNotices) await ruleHistoryTx(tx, ticket, { ruleId: rule.ruleId, ruleName: rule.name, actions: done });
  await writeAudit(tx, { action: 'rule.applied', objectType: 'ticket', objectId: snapshot.ticketId, orgId: snapshot.orgId, diff: { ruleId: rule.ruleId, ruleName: rule.name, result, actions: done } });
  run.applied++;
  return result;
}

/**
 * Правила, которым достаётся событие, порождённое правилом или макросом (FR-AUTO-07): только предустановленные и
 * только их собственные уведомления. Остальные действия такого правила на этом событии не выполняются, правила
 * администратора не срабатывают вовсе: цепочек правил нет.
 */
function builtinOnly(list: readonly RuleRecord[]): RuleRecord[] {
  return list.flatMap((rule) => {
    if (rule.pcode === null || !rule.isValid) return [];
    const actions = rule.actions.filter(isBuiltinAction);
    return actions.length > 0 ? [{ ...rule, actions }] : [];
  });
}

/**
 * Обработчик события для processEvents: работает в транзакции события вместе с отметкой разбора. На событие,
 * порождённое правилом или макросом, правила администратора не срабатывают (FR-AUTO-07): выполняются только
 * уведомления предустановленных правил (builtinOnly). Правила применяются только к обращению события.
 */
export async function handleRuleEventTx(tx: Tx, event: DomainEvent, run: RuleRun): Promise<void> {
  if (!RULE_EVENT_SET.has(event.kind) || event.kind === 'no_activity') return;
  const enabled = await enabledRulesTx(tx, event.kind as RuleEventKind);
  const list = event.isByRule ? builtinOnly(enabled) : enabled;
  if (list.length === 0) return;
  // Блокировка обращения на всё событие: правила и сотрудник не меняют его одновременно.
  const locked = await lockRuleTicketTx(tx, event.ticketId);
  if (!locked || locked.orgId !== event.orgId) return;
  let snapshot = await snapshotTx(tx, event.ticketId, run.now());
  // Последняя попытка разбора события: после её сбоя событие снимается с очереди.
  const lastAttempt = event.attempts >= EVENT_MAX_ATTEMPTS - 1;
  // После правила с флагом "остановить" правила администратора не разбираются, а уведомления предустановленных
  // правил выполняются: это уведомления портала (дежурным о P1, руководителю о сроке и оценке), а не маршрутизация,
  // и правило администратора выше по списку их не глушит (проверка вехи M8, находка I7).
  let stopped = false;
  for (const listed of list) {
    if (!snapshot) return;
    const rule = stopped ? builtinOnly([listed])[0] : listed;
    if (!rule) continue;
    if (!rule.isValid) {
      logEvent('warn', 'automation.rule_invalid', { ruleId: rule.ruleId });
      continue;
    }
    if (!evaluate(rule, snapshot, run.now())) continue;
    const result = await applyRuleTx(tx, rule, snapshot, { eventId: event.eventId, marker: null, payload: event.payload, kind: event.kind as RuleEventKind, lastAttempt }, run);
    if (result === 'skipped_loop') continue;
    // Следующее правило видит изменения этого.
    snapshot = await snapshotTx(tx, event.ticketId, run.now());
    // Правило, у которого не выполнено ни одно действие, следующие не останавливает: оно ничего не сделало.
    if (rule.isStop && result !== 'failed') stopped = true;
  }
}

// --- Событие "нет активности" (решение 5 плана M8) ---

const HOUR_MS = 3_600_000;
const OPEN_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter((status) => status !== 'resolved' && status !== 'closed');
/** Сколько обращений читает один шаг и сколько одно правило просматривает за запуск: остальные возьмёт следующая минута. */
const SILENT_BATCH = 200;
const SILENT_PER_RUN = 2000;
/**
 * Бюджет времени одного просмотра на все правила (проверка вехи M8, находка I5). Просмотр идёт в той же задаче, что
 * разбор событий: без бюджета длинный просмотр задерживал бы события, среди которых сообщение дежурным о P1.
 */
const SILENT_BUDGET_MS = 20_000;
/**
 * Где правило остановилось в прошлый запуск: следующий продолжает с этого места, обращения дальше первой пачки не
 * ждут вечно. Память процесса: после перезапуска просмотр начинается сначала, срабатывания от этого не повторяются.
 */
const cursors = (globalThis as typeof globalThis & { __hubSilentCursors?: Map<string, string | null> }).__hubSilentCursors ??= new Map<string, string | null>();

/**
 * Статусы, в которых правило ищет молчащие обращения: решённые и закрытые не берутся, если условие правила "статус
 * равен" не называет статусы само. Отбор в базе грубый, точное решение принимают условия правила на снимке.
 *
 * Названные статусы сужают просмотр, только когда должны выполняться все условия: каждое условие "статус равен"
 * обязательно, подходят статусы, названные во всех таких условиях. При "любое из условий" обращение в другом
 * статусе может подойти по соседнему условию, поэтому просматриваются все открытые (проверка вехи M8, находка I2).
 */
export function silentStatuses(rule: Pick<RuleRecord, 'conditions'>): TicketStatus[] {
  if (rule.conditions.match !== 'all') return [...OPEN_STATUSES];
  const named = rule.conditions.items.flatMap((item) => (item.field === 'status' && item.op === 'is' ? [item.values] : []));
  const [first, ...rest] = named;
  return first ? [...new Set(first)].filter((status) => rest.every((values) => values.includes(status))) : [...OPEN_STATUSES];
}

/**
 * Отбор просмотра "нет активности": молчание началось не позже cutoff (прошло не меньше hours часов) и обращение в
 * одном из статусов statuses. Тот же отбор берёт пробный прогон правила (silentForDryRunTx).
 */
export function silentSelection(rule: Pick<RuleRecord, 'conditions'> & { hours: number }, now: Date): { cutoff: Date; statuses: TicketStatus[] } {
  return { cutoff: new Date(now.getTime() - rule.hours * HOUR_MS), statuses: silentStatuses(rule) };
}

/**
 * Молчащие обращения для пробного прогона (волна 5, задача 2): тот же отбор и то же определение молчания, что у
 * просмотра, последние limit по номеру. Момент включения правила не учитывается: прогон отвечает, каким обращениям
 * правило подошло бы сейчас. Уже отмеченные срабатывания тоже не исключаются. Статусы возвращаются для проверки на
 * снимке, как перед применением.
 */
export async function silentForDryRunTx(tx: Tx, rule: Pick<RuleRecord, 'conditions'> & { hours: number }, now: Date, limit: number): Promise<{ ticketIds: string[]; statuses: TicketStatus[] }> {
  const { cutoff, statuses } = silentSelection(rule, now);
  const silent = await silentTicketsTx(tx, { cutoff, statuses, after: null, limit, newest: true });
  return { ticketIds: silent.map((item) => item.ticketId), statuses };
}

/** Нужны ли условиям правила тема и описание обращения. */
const needsText = (rule: Pick<RuleRecord, 'conditions'>): boolean => rule.conditions.items.some((item) => item.field === 'text');

/**
 * Граница включения: молчание должно достичь N часов не раньше включения правила, то есть начаться не раньше, чем за
 * N часов до него. Обращения, молчавшие N часов ещё до включения, правило не трогает до нового сообщения.
 * Правило без момента включения (включено поставкой) границы не имеет.
 */
const silenceFloor = (enabledOn: Date | null, hours: number): Date | null => (enabledOn ? new Date(enabledOn.getTime() - hours * HOUR_MS) : null);

export type NoActivityOptions = {
  now?: Date;
  batch?: number;
  perRun?: number;
  stopped?: () => boolean;
  run?: RuleRun;
  /** Бюджет времени запуска на все правила: когда он исчерпан, просмотр останавливается между пачками. */
  budgetMs?: number;
  /** Часы для бюджета: тесты их подменяют. */
  clock?: () => number;
  /** Вызывается перед каждой пачкой: фоновый процесс разбирает в этот момент накопившиеся события. */
  between?: () => Promise<void>;
};

/**
 * Событие "нет активности N часов": вызывается задачей automation.process раз в минуту, не на каждое событие.
 * Для каждого включённого правила берутся обращения, у которых с последнего сообщения человека прошло N часов и у
 * которых нет срабатывания этого правила с отметкой этого молчания. Условия проверяются на снимке; подошедшее
 * обращение применяется своей транзакцией под блокировкой строки, с перепроверкой молчания. Отметка и уникальный
 * индекс hdw_rule_runs_u1 дают одно срабатывание на молчание и при двух процессах; новое сообщение взводит заново.
 * Молчание, достигшее N часов до включения правила, не срабатывает (silenceFloor).
 *
 * Просмотр ограничен по времени (budgetMs на все правила запуска): он останавливается между пачками и в следующий
 * запуск продолжает с того же места (cursors). Перед каждой пачкой вызывается between: события обращений не ждут
 * конца просмотра. Тема и описание читаются, только если они нужны условию правила.
 */
export async function runNoActivityTx(actor: SystemActor, opts: NoActivityOptions = {}): Promise<{ checked: number; applied: number; failed: number }> {
  if (actor.type !== 'system') throw new Error('Правила применяет только система');
  const now = opts.now ?? new Date();
  const run = opts.run ?? createRuleRun({ now: () => now });
  const batch = Math.max(1, opts.batch ?? SILENT_BATCH);
  const perRun = Math.max(batch, opts.perRun ?? SILENT_PER_RUN);
  const before = { applied: run.applied, failed: run.failed };
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? SILENT_BUDGET_MS);
  let exhausted = false;
  let checked = 0;
  const list = await withActor(actor, (tx) => enabledRulesTx(tx, 'no_activity'));
  for (const rule of list) {
    if (exhausted) break;
    if (!rule.isValid || rule.hours === null) continue;
    const hours = rule.hours;
    const { cutoff, statuses } = silentSelection({ ...rule, hours }, now);
    let after = cursors.get(rule.ruleId) ?? null;
    const withText = needsText(rule);
    let seen = 0;
    while (seen < perRun && opts.stopped?.() !== true) {
      if (clock() >= deadline) {
        // Бюджет исчерпан: место остановки запоминается, это и следующие правила продолжит следующая минута.
        exhausted = true;
        logEvent('warn', 'automation.no_activity_budget', { ruleId: rule.ruleId, checked });
        break;
      }
      await opts.between?.();
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
        const snapshots = await snapshotsTx(tx, waiting.map((item) => item.ticketId), now, { withText });
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
          await withActorForTicket(actor, { ticketId: item.ticketId }, async (tx) => {
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
            // У события "нет активности" счётчика попыток нет: сбой действия записывается отказом, как на последней попытке.
            await applyRuleTx(tx, rule, snapshot, { eventId: null, marker: item.marker, lastAttempt: true }, run);
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
