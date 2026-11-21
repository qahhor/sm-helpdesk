import { expect, test } from 'vitest';
import { loadSlaConfig, saveCalendar, saveHolidays, saveSlaPolicy } from '@/modules/hdr/api';
import { asActor, pools } from './helpers/db';
import { staffCtx } from './helpers/auth';
import { seedTwoOrgs } from './isolation/fixture';

// Сроки и рабочий календарь (ТЗ, раздел 7.4, FR-SLA-01, FR-SLA-12; план M3, задача 2).

// Значения по умолчанию в коде: без строк таблиц действуют сроки раздела 7.4.
const restoreDefaults = () => pools.root.query(`delete from hdr_sla_policies; delete from hdr_business_calendars;`);

test('сроки и рабочее время по умолчанию совпадают с разделом 7.4', async () => {
  await restoreDefaults();
  const f = await seedTwoOrgs();
  const config = await loadSlaConfig(f.aUser.actor);
  expect(config.policies).toEqual({
    p1: { firstResponseMinutes: 15, resolutionMinutes: 180, resolutionDays: null, clock: 'business' },
    p2: { firstResponseMinutes: 60, resolutionMinutes: 480, resolutionDays: null, clock: 'business' },
    p3: { firstResponseMinutes: 240, resolutionMinutes: null, resolutionDays: 2, clock: 'business' },
    p4: { firstResponseMinutes: 480, resolutionMinutes: null, resolutionDays: 5, clock: 'business' },
  });
  expect(config.calendar).toEqual({
    timeZone: 'Asia/Tashkent',
    week: { 0: null, 1: ['08:00', '20:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: ['09:00', '17:00'] },
    holidays: [],
  });
});

test('менять сроки и календарь может только администратор: в коде и в базе', async () => {
  await restoreDefaults();
  const f = await seedTwoOrgs();
  await expect(saveSlaPolicy(staffCtx(f.l1), { priority: 'p2', firstResponseMinutes: 30, resolutionMinutes: 240, clock: 'business' })).rejects.toMatchObject({
    code: 'forbidden',
  });
  await saveSlaPolicy(staffCtx(f.adminStaff), { priority: 'p2', firstResponseMinutes: 60, resolutionMinutes: 480, clock: 'business' });
  for (const actor of [f.l1.actor, f.care.actor, f.aAdmin.actor, { type: 'system', job: 'test' } as const]) {
    expect((await asActor(pools.app, actor, (c) => c.query(`update hdr_sla_policies set first_response_minutes = 1`))).rowCount).toBe(0);
    await expect(
      asActor(pools.app, actor, (c) =>
        c.query(`insert into hdr_sla_policies (priority, first_response_minutes, resolution_minutes, calendar_id) select 'p1', 1, 1, calendar_id from hdr_business_calendars`),
      ),
    ).rejects.toThrow(/row-level security|duplicate key/);
    await expect(asActor(pools.app, actor, (c) => c.query(`delete from hdr_sla_policies`))).rejects.toThrow(/permission denied/);
  }
  await saveSlaPolicy(staffCtx(f.adminStaff), { priority: 'p1', firstResponseMinutes: 15, resolutionMinutes: 180, clock: '24x7' });
  expect((await loadSlaConfig(f.l1.actor)).policies.p1.clock).toBe('24x7');
  await restoreDefaults();
});

test('изменение сроков, графика и праздников пишется в журнал аудита', async () => {
  await restoreDefaults();
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  await saveSlaPolicy(admin, { priority: 'p3', firstResponseMinutes: 120, resolutionDays: 3, clock: 'business' });
  await saveCalendar(admin, {
    timeZone: 'Asia/Tashkent',
    week: { 0: null, 1: ['08:00', '19:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: null },
  });
  await saveHolidays(admin, { year: 2027, dates: ['2027-01-01', '2027-03-21'] });
  await saveHolidays(admin, { year: 2026, dates: ['2026-12-08'] });
  const config = await loadSlaConfig(f.aUser.actor);
  expect(config.policies.p3).toEqual({ firstResponseMinutes: 120, resolutionMinutes: null, resolutionDays: 3, clock: 'business' });
  expect(config.calendar.week[6]).toBeNull();
  expect(config.calendar.holidays).toEqual(['2026-12-08', '2027-01-01', '2027-03-21']);
  // Повторное сохранение года заменяет его даты, другие годы не трогает.
  await saveHolidays(admin, { year: 2027, dates: ['2027-01-01'] });
  expect((await loadSlaConfig(f.aUser.actor)).calendar).toMatchObject({ holidays: ['2026-12-08', '2027-01-01'] });
  const audit = await pools.root.query(
    `select action, diff from hdc_audit_log where action like 'sla.%' and actor_id = $1 order by created_on, audit_id`,
    [f.adminStaff.userId],
  );
  expect(audit.rows.map((r) => r.action)).toEqual(['sla.policy_changed', 'sla.calendar_changed', 'sla.holidays_changed', 'sla.holidays_changed', 'sla.holidays_changed']);
  expect(audit.rows[0].diff).toMatchObject({ priority: 'p3', to: { firstResponseMinutes: 120, resolutionDays: 3 } });
  await restoreDefaults();
});

test('неверные значения отклоняются схемой', async () => {
  const f = await seedTwoOrgs();
  const admin = staffCtx(f.adminStaff);
  const week = { 0: null, 1: ['08:00', '20:00'], 2: null, 3: null, 4: null, 5: null, 6: null };
  for (const bad of [
    () => saveSlaPolicy(admin, { priority: 'p2', firstResponseMinutes: 0, resolutionMinutes: 480, clock: 'business' }),
    () => saveSlaPolicy(admin, { priority: 'p2', firstResponseMinutes: 60, resolutionMinutes: 480, resolutionDays: 2, clock: 'business' }),
    () => saveSlaPolicy(admin, { priority: 'p5', firstResponseMinutes: 60, resolutionMinutes: 480, clock: 'business' }),
    () => saveCalendar(admin, { timeZone: 'Asia/Tashkent', week: { ...week, 1: ['20:00', '08:00'] } }),
    () => saveCalendar(admin, { timeZone: 'Mars/Olympus', week }),
    () => saveCalendar(admin, { timeZone: 'Asia/Tashkent', week: { ...week, 1: null } }),
    () => saveHolidays(admin, { year: 2027, dates: ['2026-12-31'] }),
    () => saveHolidays(admin, { year: 2027, dates: ['2027-01-01', '2027-01-01'] }),
    () => saveHolidays(admin, { year: 2027, dates: ['2027-02-30'] }),
  ])
    await expect(bad()).rejects.toMatchObject({ code: 'invalid_input' });
});
