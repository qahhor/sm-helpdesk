import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type Actor, type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { DEFAULT_CALENDAR_CODE, DEFAULT_SLA_POLICIES, DEFAULT_TIMEZONE, DEFAULT_WEEK } from '../pref';
import { businessCalendars, slaPolicies, type WeekHours } from '../schema';

// Модуль hdr, слой core: сроки SLA и рабочий календарь (ТЗ, раздел 7.4, FR-SLA-01, FR-SLA-12; план M3, задача 2).
// Значения по умолчанию в pref.ts, строка таблицы действует вместо них (решение 0032). Читает любой актор. Меняет
// только администратор: роль проверяет слой api, а база повторяет проверку политикой.

export type Priority = 'p1' | 'p2' | 'p3' | 'p4';
export type SlaPolicy = { firstResponseMinutes: number; resolutionMinutes: number | null; resolutionDays: number | null; clock: 'business' | '24x7' };
/** Тот же вид, что Calendar в src/modules/hdt/sla.ts: модуль hdt получает календарь готовым к расчёту. */
export type SlaCalendar = { timeZone: string; week: Record<0 | 1 | 2 | 3 | 4 | 5 | 6, [string, string] | null>; holidays: string[] };
export type SlaConfig = { policies: Record<Priority, SlaPolicy>; calendar: SlaCalendar };

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const PRIORITIES: readonly Priority[] = ['p1', 'p2', 'p3', 'p4'];

const defaultWeek = (): SlaCalendar['week'] =>
  Object.fromEntries(DAYS.map((day) => [day, DEFAULT_WEEK[day] ? [...DEFAULT_WEEK[day]] : null])) as SlaCalendar['week'];
const defaultPolicy = (priority: Priority): SlaPolicy => ({ ...DEFAULT_SLA_POLICIES[priority] });

const toWeek = (hours: WeekHours): SlaCalendar['week'] =>
  Object.fromEntries(DAYS.map((day) => [day, hours[String(day) as keyof WeekHours] ?? null])) as SlaCalendar['week'];
const fromWeek = (week: SlaCalendar['week']): WeekHours =>
  Object.fromEntries(DAYS.map((day) => [String(day), week[day] ?? null])) as WeekHours;

/** Сроки и календарь внутри уже открытой транзакции: для пересчёта сроков обращения в той же транзакции. */
export async function readSlaConfig(tx: Tx): Promise<SlaConfig> {
  const [calendar] = await tx.select().from(businessCalendars).where(eq(businessCalendars.code, DEFAULT_CALENDAR_CODE)).limit(1);
  const rows = await tx.select().from(slaPolicies).orderBy(asc(slaPolicies.priority));
  const policies = Object.fromEntries(
    PRIORITIES.map((priority) => {
      const row = rows.find((r) => r.priority === priority);
      return [
        priority,
        row
          ? { firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes, resolutionDays: row.resolutionDays, clock: row.clock }
          : defaultPolicy(priority),
      ];
    }),
  ) as Record<Priority, SlaPolicy>;
  return {
    policies,
    calendar: calendar
      ? { timeZone: calendar.timezone, week: toWeek(calendar.weekHours), holidays: [...calendar.holidays].sort() }
      : { timeZone: DEFAULT_TIMEZONE, week: defaultWeek(), holidays: [] },
  };
}

/** Строка календаря по умолчанию: создаётся с графиком раздела 7.4, если её ещё нет. Под блокировкой строки. */
async function lockCalendar(tx: Tx) {
  await tx
    .insert(businessCalendars)
    .values({ code: DEFAULT_CALENDAR_CODE, timezone: DEFAULT_TIMEZONE, weekHours: fromWeek(defaultWeek()) })
    .onConflictDoNothing({ target: businessCalendars.code });
  const [row] = await tx.select().from(businessCalendars).where(eq(businessCalendars.code, DEFAULT_CALENDAR_CODE)).for('update');
  if (!row) throw new Error('hdr: календарь не создан');
  return row;
}

export function loadSlaConfigTx(actor: Actor): Promise<SlaConfig> {
  return withActor(actor, readSlaConfig);
}

export async function saveSlaPolicyTx(staff: StaffActor, priority: Priority, policy: SlaPolicy): Promise<void> {
  await withActor(staff, async (tx) => {
    const calendar = await lockCalendar(tx);
    const before = (await readSlaConfig(tx)).policies[priority];
    await tx
      .insert(slaPolicies)
      .values({ priority, ...policy, calendarId: calendar.calendarId })
      .onConflictDoUpdate({
        target: slaPolicies.priority,
        set: { firstResponseMinutes: policy.firstResponseMinutes, resolutionMinutes: policy.resolutionMinutes, resolutionDays: policy.resolutionDays, clock: policy.clock },
      });
    await writeAudit(tx, { action: 'sla.policy_changed', objectType: 'sla_policy', objectId: priority, diff: { priority, from: before, to: policy } });
  });
}

export async function saveCalendarTx(staff: StaffActor, calendar: Pick<SlaCalendar, 'timeZone' | 'week'>): Promise<void> {
  await withActor(staff, async (tx) => {
    const before = await lockCalendar(tx);
    await tx
      .update(businessCalendars)
      .set({ timezone: calendar.timeZone, weekHours: fromWeek(calendar.week) })
      .where(eq(businessCalendars.calendarId, before.calendarId));
    await writeAudit(tx, {
      action: 'sla.calendar_changed',
      objectType: 'business_calendar',
      objectId: before.calendarId,
      diff: { from: { timeZone: before.timezone, week: before.weekHours }, to: { timeZone: calendar.timeZone, week: fromWeek(calendar.week) } },
    });
  });
}

/** Заменяет праздники одного года, остальные годы не трогает. */
export async function saveHolidaysTx(staff: StaffActor, year: number, dates: string[]): Promise<void> {
  await withActor(staff, async (tx) => {
    const before = await lockCalendar(tx);
    const prefix = `${year}-`;
    const holidays = [...before.holidays.filter((date) => !date.startsWith(prefix)), ...dates].sort();
    await tx.update(businessCalendars).set({ holidays }).where(eq(businessCalendars.calendarId, before.calendarId));
    await writeAudit(tx, {
      action: 'sla.holidays_changed',
      objectType: 'business_calendar',
      objectId: before.calendarId,
      diff: { year, from: before.holidays.filter((date) => date.startsWith(prefix)).sort(), to: [...dates].sort() },
    });
  });
}
