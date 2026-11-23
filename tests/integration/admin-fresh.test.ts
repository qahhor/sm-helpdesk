import { beforeEach, expect, test } from 'vitest';
import { saveOncall, saveSupportAddresses, unblockSender } from '@/modules/hdn/api/mail-settings';
import { saveCalendar, saveHolidays, saveSlaPolicy } from '@/modules/hdr/api';
import { saveTimings } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Свежий вход для всех настроек администратора (аудит 23.11.2026, находка S10; ТЗ 14.3, решение 0014): перехваченная
// сессия старше 15 минут не меняет адреса поддержки, дежурных, сроки и календарь.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

const WEEK = { 0: null, 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: null };
const TIMINGS = { waitingReminderDays: 3, autocloseResolvedDays: 5, autocloseWaitingDays: 7, updateIntervalDays: 7 };

test('настройки с сессией старше 15 минут: stale_session, со свежей сохраняются', async () => {
  const fresh = staffCtx(f.adminStaff);
  const stale = { ...fresh, sessionCreatedAt: new Date(Date.now() - 901e3) };
  const calls: [string, (ctx: typeof fresh) => Promise<unknown>][] = [
    ['адреса поддержки', (ctx) => saveSupportAddresses(ctx, [{ address: 'support@smartup24.com', shown: true }])],
    ['дежурные', (ctx) => saveOncall(ctx, { emails: ['duty@smartup24.com'], chatId: null, bot: 'main' })],
    ['спам', (ctx) => unblockSender(ctx, 'nobody@example.uz')],
    ['сроки напоминаний', (ctx) => saveTimings(ctx, TIMINGS)],
    ['политика SLA', (ctx) => saveSlaPolicy(ctx, { priority: 'p3', firstResponseMinutes: '240', resolutionDays: '3', clock: 'business' })],
    ['календарь', (ctx) => saveCalendar(ctx, { timeZone: 'Asia/Tashkent', week: WEEK })],
    ['праздники', (ctx) => saveHolidays(ctx, { year: 2027, dates: ['2027-01-01'] })],
  ];
  for (const [name, call] of calls) {
    await expect(call(stale), name).rejects.toMatchObject({ code: 'stale_session' });
    await expect(call(fresh), name).resolves.not.toThrow();
  }
});
