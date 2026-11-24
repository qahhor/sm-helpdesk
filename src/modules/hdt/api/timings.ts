import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { readSetting, writeSettingTx } from '@/modules/hdc/api';
import type { StaffContext } from '@/modules/hdu/api';
import { FRESH_SIGN_IN_SEC, isFresh } from '@/modules/hdu/api/session';
import { HdtError } from '../error';
import { parseInput } from '../input';
import {
  AUTOCLOSE_RESOLVED_SETTING,
  AUTOCLOSE_WAITING_SETTING,
  DAY_SETTING_MAX,
  DAY_SETTING_MIN,
  DAY_SETTINGS_DEFAULT,
  PICKUP_SETTING,
  UPDATE_DUE_SETTING,
  WAITING_REMINDER_SETTING,
} from '../pref';

// Модуль hdt, слой api: сроки напоминаний и автозакрытия (решение 24 вехи M4, FR-SLA-09, FR-TK-15). Задаёт администратор
// в рабочих днях от 1 до 30, их читают напоминание клиенту, автозакрытие и напоминание о регулярном обновлении.

export type Timings = { waitingReminderDays: number; autocloseResolvedDays: number; autocloseWaitingDays: number; updateIntervalDays: number };

const CODES = {
  waitingReminderDays: WAITING_REMINDER_SETTING,
  autocloseResolvedDays: AUTOCLOSE_RESOLVED_SETTING,
  autocloseWaitingDays: AUTOCLOSE_WAITING_SETTING,
  updateIntervalDays: UPDATE_DUE_SETTING,
} as const;

const day = z.coerce.number().int().min(DAY_SETTING_MIN).max(DAY_SETTING_MAX);
const timingsInput = z.object({ waitingReminderDays: day, autocloseResolvedDays: day, autocloseWaitingDays: day, updateIntervalDays: day }).strict();

/** Значения по умолчанию из ТЗ: подписи на экране настроек. */
export const TIMINGS_DEFAULT: Timings = {
  waitingReminderDays: DAY_SETTINGS_DEFAULT[WAITING_REMINDER_SETTING],
  autocloseResolvedDays: DAY_SETTINGS_DEFAULT[AUTOCLOSE_RESOLVED_SETTING],
  autocloseWaitingDays: DAY_SETTINGS_DEFAULT[AUTOCLOSE_WAITING_SETTING],
  updateIntervalDays: DAY_SETTINGS_DEFAULT[UPDATE_DUE_SETTING],
};

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.staffRole !== 'admin') throw new HdtError('forbidden');
}

/** Изменение настройки: администратор со входом не старше 15 минут (ТЗ 14.3, решение 0014; аудит 23.11.2026, S10). */
function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdtError('stale_session');
}

export async function readTimings(ctx: StaffContext): Promise<Timings> {
  requireAdmin(ctx);
  const entries = await Promise.all(
    (Object.keys(CODES) as (keyof Timings)[]).map(async (key) => {
      const value = await readSetting(CODES[key]);
      return [key, day.safeParse(value).success ? Number(value) : TIMINGS_DEFAULT[key]] as const;
    }),
  );
  return Object.fromEntries(entries) as Timings;
}

/** Четыре срока одной транзакцией, каждый с записью журнала. */
export async function saveTimings(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parseInput(timingsInput, input);
  await withActor(ctx.actor, async (tx) => {
    for (const key of Object.keys(CODES) as (keyof Timings)[]) await writeSettingTx(tx, CODES[key], data[key]);
  });
}

// --- Срок "взять в работу" после передачи на вторую линию (FR-LINE-06; решение 0040, пункт 4) ---

const PICKUP_PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type PickupMinutes = Record<(typeof PICKUP_PRIORITIES)[number], number | null>;

/** Рабочих минут от 1 до 100 000 или пусто: тогда действует срок первого ответа этого приоритета. */
const pickupValue = z.preprocess((value) => (value === '' || value === null || value === undefined ? null : value), z.coerce.number().int().min(1).max(100_000).nullable());
const pickupInput = z.object({ p1: pickupValue, p2: pickupValue, p3: pickupValue, p4: pickupValue }).strict();

export async function readPickup(ctx: StaffContext): Promise<PickupMinutes> {
  requireAdmin(ctx);
  const setting = await readSetting(PICKUP_SETTING);
  const saved = setting && typeof setting === 'object' && !Array.isArray(setting) ? (setting as Record<string, unknown>) : {};
  return Object.fromEntries(PICKUP_PRIORITIES.map((priority) => [priority, pickupValue.safeParse(saved[priority]).data ?? null])) as PickupMinutes;
}

/** Сохраняет только заданные приоритеты: остальным срок считается от срока первого ответа (pickupMinutes). */
export async function savePickup(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parseInput(pickupInput, input);
  const value = Object.fromEntries(PICKUP_PRIORITIES.filter((priority) => data[priority] !== null).map((priority) => [priority, data[priority]]));
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, PICKUP_SETTING, value));
}
