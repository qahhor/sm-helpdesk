import 'server-only';
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { SlaConfig } from '@/modules/hdr/api';
import { readSlaConfig } from '@/modules/hdr/api';
import type { Priority } from '../pref';
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

/** Момент события статуса: последний вход в to не позже now или первый выход из from не раньше since. */
async function statusMoment(tx: Tx, ticketId: string, opts: { to: string; notAfter: Date } | { from: string; since: Date }): Promise<Date | null> {
  const where =
    'to' in opts
      ? and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, 'status'), sql`${ticketEvents.payload}->>'to' = ${opts.to}`, lte(ticketEvents.createdOn, opts.notAfter))
      : and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, 'status'), sql`${ticketEvents.payload}->>'from' = ${opts.from}`, gte(ticketEvents.createdOn, opts.since));
  const [row] = await tx
    .select({ at: ticketEvents.createdOn })
    .from(ticketEvents)
    .where(where)
    .orderBy('to' in opts ? desc(ticketEvents.createdOn) : asc(ticketEvents.createdOn))
    .limit(1);
  return row?.at ?? null;
}

/** Пересчёт сроков в транзакции актора, который меняет обращение. Нет обращения или оно не видно актору: null. */
export async function refreshSla(tx: Tx, ticketId: string, now: Date): Promise<SlaState | null> {
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
  const config = await readSlaConfig(tx);
  const cal = calendarFor(config, t.priority);
  let pausedOn = t.pausedOn;
  let pausedMinutes = t.pausedMinutes;
  if (t.status === 'waiting_customer' && !pausedOn) {
    pausedOn = (await statusMoment(tx, ticketId, { to: 'waiting_customer', notAfter: now })) ?? now;
  } else if (t.status !== 'waiting_customer' && pausedOn) {
    const resumed = (await statusMoment(tx, ticketId, { from: 'waiting_customer', since: pausedOn })) ?? now;
    pausedMinutes += workingMinutesBetween(pausedOn, resumed, cal);
    pausedOn = null;
  }
  const settled = t.status === 'resolved' || t.status === 'closed';
  const due = dueDates(t.createdOn, t.priority, pausedMinutes, config);
  const next = {
    firstResponseDueOn: settled && t.firstResponseDueOn ? t.firstResponseDueOn : due.firstResponseDueOn,
    resolutionDueOn: settled && t.resolutionDueOn ? t.resolutionDueOn : due.resolutionDueOn,
  };
  await tx
    .update(tickets)
    .set({ ...next, slaPausedOn: pausedOn, slaPausedMinutes: pausedMinutes })
    .where(eq(tickets.ticketId, ticketId));
  return { ...next, pausedSince: pausedOn };
}

/** Обращения, где пересчёт после действия клиента не прошёл: нет сроков или пауза не совпадает со статусом. */
export async function needsSlaRefreshTx(tx: Tx, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ ticketId: tickets.ticketId })
    .from(tickets)
    .where(
      or(
        and(notInArray(tickets.status, ['resolved', 'closed']), or(isNull(tickets.firstResponseDueOn), isNull(tickets.resolutionDueOn))),
        and(ne(tickets.status, 'waiting_customer'), isNotNull(tickets.slaPausedOn)),
        and(eq(tickets.status, 'waiting_customer'), isNull(tickets.slaPausedOn)),
      ),
    )
    .orderBy(asc(tickets.createdOn))
    .limit(limit);
  return rows.map((row) => row.ticketId);
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
