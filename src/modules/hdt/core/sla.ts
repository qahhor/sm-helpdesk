import 'server-only';
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Tx } from '@/db/client';
import type { SlaConfig } from '@/modules/hdr/api';
import { readSlaConfig } from '@/modules/hdr/api';
import type { Priority, TicketStatus } from '../pref';
import { addWorkingDays, addWorkingMinutes, type Calendar, workingMinutesBetween } from '../sla';
import { ticketEvents, tickets } from '../schema';

// Модуль hdt, слой core: сроки обращения (ТЗ: 7.4, FR-SLA-03, FR-SLA-05, 11.7; решения 1, 2, 7 плана M3, решение 0032).
// Одна функция пересчитывает оба срока по событиям обращения: создание, смена приоритета, вход и выход из
// "Ждём вашего ответа", первый ответ. Моменты паузы берутся из истории статусов, поэтому досчёт задачей позже
// события не искажает паузу. Решённое и закрытое срок решения не двигают.

export type SlaState = { firstResponseDueOn: Date | null; resolutionDueOn: Date | null; pausedSince: Date | null };

export const calendarFor = (config: SlaConfig, priority: Priority): Calendar =>
  config.policies[priority].clock === '24x7' ? '24x7' : config.calendar;

/** Сроки от момента создания с учётом рабочих минут паузы. */
export function dueDates(createdOn: Date, priority: Priority, pausedMinutes: number, config: SlaConfig): { firstResponseDueOn: Date; resolutionDueOn: Date } {
  const policy = config.policies[priority];
  const cal = calendarFor(config, priority);
  const base =
    policy.resolutionDays !== null ? addWorkingDays(createdOn, policy.resolutionDays, cal) : addWorkingMinutes(createdOn, policy.resolutionMinutes ?? 0, cal);
  return {
    firstResponseDueOn: addWorkingMinutes(createdOn, policy.firstResponseMinutes, cal),
    resolutionDueOn: pausedMinutes > 0 ? addWorkingMinutes(base, pausedMinutes, cal) : base,
  };
}

/**
 * Статусы, в которых срок решения стоит: ход клиента. "Ждём вашего ответа" (FR-SLA-05), а также "Решено" и
 * "Закрыто": открытое снова обращение продолжает срок с того места, где его решили (итоговая проверка M3).
 */
export const PAUSED_STATUSES: readonly TicketStatus[] = ['waiting_customer', 'resolved', 'closed'];
const PAUSED_SQL = sql`(${sql.join(PAUSED_STATUSES.map((status) => sql`${status}`), sql`, `)})`;

/** Момент события статуса: последний вход в паузу не позже now или первый выход из паузы не раньше since. */
async function statusMoment(tx: Tx, ticketId: string, opts: { enter: true; notAfter: Date } | { enter: false; since: Date }): Promise<Date | null> {
  const where = opts.enter
    ? and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, 'status'), sql`${ticketEvents.payload}->>'to' in ${PAUSED_SQL}`, lte(ticketEvents.createdOn, opts.notAfter))
    : and(
        eq(ticketEvents.ticketId, ticketId),
        eq(ticketEvents.kind, 'status'),
        sql`${ticketEvents.payload}->>'from' in ${PAUSED_SQL}`,
        sql`${ticketEvents.payload}->>'to' not in ${PAUSED_SQL}`,
        gte(ticketEvents.createdOn, opts.since),
      );
  const [row] = await tx
    .select({ at: ticketEvents.createdOn })
    .from(ticketEvents)
    .where(where)
    .orderBy(opts.enter ? desc(ticketEvents.createdOn) : asc(ticketEvents.createdOn))
    .limit(1);
  return row?.at ?? null;
}

/** Поля строки обращения, которые действие меняет вместе с пересчётом сроков. */
export type TicketPatch = PgUpdateSetSource<typeof tickets>;

/**
 * Пересчёт сроков в транзакции актора, который меняет обращение. Нет обращения или оно не видно актору: null.
 *
 * set: поля, которые действие меняет тем же обновлением (статус, приоритет, исполнитель). Сроки считаются уже
 * по новым статусу и приоритету, и строка обращения пишется один раз вместо двух (аудит 23.11.2026, находка P8).
 * Событие смены статуса действие пишет до вызова: по его времени ставится начало паузы.
 * Без set и без изменения сроков обновления нет вовсе.
 */
export async function refreshSla(tx: Tx, ticketId: string, now: Date, set: TicketPatch = {}): Promise<SlaState | null> {
  const [t] = await tx
    .select({
      createdOn: tickets.createdOn,
      priority: tickets.priority,
      status: tickets.status,
      pausedOn: tickets.slaPausedOn,
      pausedMinutes: tickets.slaPausedMinutes,
      firstResponseDueOn: tickets.firstResponseDueOn,
      resolutionDueOn: tickets.resolutionDueOn,
    })
    .from(tickets)
    .where(eq(tickets.ticketId, ticketId))
    .for('update');
  if (!t) return null;
  const status = typeof set.status === 'string' ? (set.status as typeof t.status) : t.status;
  const priority = typeof set.priority === 'string' ? (set.priority as typeof t.priority) : t.priority;
  const config = await readSlaConfig(tx);
  const cal = calendarFor(config, priority);
  let pausedOn = t.pausedOn;
  let pausedMinutes = t.pausedMinutes;
  const paused = PAUSED_STATUSES.includes(status);
  if (paused && !pausedOn) {
    pausedOn = (await statusMoment(tx, ticketId, { enter: true, notAfter: now })) ?? now;
  } else if (!paused && pausedOn) {
    const resumed = (await statusMoment(tx, ticketId, { enter: false, since: pausedOn })) ?? now;
    pausedMinutes += workingMinutesBetween(pausedOn, resumed, cal);
    pausedOn = null;
  }
  const settled = status === 'resolved' || status === 'closed';
  const due = dueDates(t.createdOn, priority, pausedMinutes, config);
  const next = {
    firstResponseDueOn: settled && t.firstResponseDueOn ? t.firstResponseDueOn : due.firstResponseDueOn,
    resolutionDueOn: settled && t.resolutionDueOn ? t.resolutionDueOn : due.resolutionDueOn,
  };
  const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const slaChanged =
    !same(next.firstResponseDueOn, t.firstResponseDueOn) || !same(next.resolutionDueOn, t.resolutionDueOn) || !same(pausedOn, t.pausedOn) || pausedMinutes !== t.pausedMinutes;
  // Сроки не изменились и действию нечего писать: строка не переписывается.
  if (slaChanged || Object.keys(set).length > 0)
    await tx
      .update(tickets)
      .set({ ...set, ...(slaChanged ? { ...next, slaPausedOn: pausedOn, slaPausedMinutes: pausedMinutes } : {}) })
      .where(eq(tickets.ticketId, ticketId));
  return { ...next, pausedSince: pausedOn };
}

/**
 * Обращения, где пересчёт после действия клиента не прошёл: нет сроков или пауза не совпадает со статусом.
 *
 * Три запроса вместо одного с "или" (аудит 23.11.2026, находка P3): каждый идёт по своему частичному индексу и не
 * просматривает закрытые обращения. Условия записаны текстом без параметров и совпадают с условиями индексов
 * hdt_tickets_i12 и hdt_tickets_i17: по ним планировщик выбирает индекс. Список статусов с паузой сверяет тест.
 */
export async function needsSlaRefreshTx(tx: Tx, limit: number): Promise<string[]> {
  const pick = (where: SQL) => tx.select({ ticketId: tickets.ticketId, createdOn: tickets.createdOn }).from(tickets).where(where).orderBy(asc(tickets.createdOn)).limit(limit);
  const open = sql`${tickets.status} not in ('resolved', 'closed')`;
  const noDueDates = await pick(and(open, or(isNull(tickets.firstResponseDueOn), isNull(tickets.resolutionDueOn))) as SQL);
  const pausedButActive = await pick(and(open, sql`${tickets.status} <> 'waiting_customer'`, isNotNull(tickets.slaPausedOn)) as SQL);
  const notPausedButShould = await pick(sql`${tickets.slaPausedOn} is null and ${tickets.status} in ('waiting_customer', 'resolved', 'closed')`);
  const rows = [...noDueDates, ...pausedButActive, ...notPausedButShould].sort((x, y) => x.createdOn.getTime() - y.createdOn.getTime());
  return [...new Set(rows.map((row) => row.ticketId))].slice(0, limit);
}

export type SlaPhase = 'calm' | 'soon' | 'breached';

/** Состояние срока (UX-A-08): нарушен, скоро (осталось меньше 20% рабочего времени срока, FR-SLA-06), спокойно. */
export function slaPhase(due: Date | null, start: Date, now: Date, cal: Calendar): SlaPhase {
  if (!due) return 'calm';
  if (now.getTime() >= due.getTime()) return 'breached';
  const total = workingMinutesBetween(start, due, cal);
  const left = workingMinutesBetween(now, due, cal);
  return total > 0 && left < total * 0.2 ? 'soon' : 'calm';
}
