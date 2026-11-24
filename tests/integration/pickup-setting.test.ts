import { beforeEach, expect, test } from 'vitest';
import { readPickup, savePickup } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Срок "взять в работу" после передачи на вторую линию (FR-LINE-06; план W3, задача 4). По умолчанию равен сроку
// первого ответа и меняется в настройках: до этой задачи настройку можно было задать только в базе.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});
const stored = () => pools.root.query(`select value from hdc_settings where code = 'lines.pickup_minutes'`).then((r) => r.rows[0]?.value ?? null);

test('по умолчанию пусто; администратор задаёт минуты по приоритетам, пустое поле возвращает срок первого ответа', async () => {
  const admin = staffCtx(f.adminStaff);
  expect(await readPickup(admin)).toEqual({ p1: null, p2: null, p3: null, p4: null });
  await savePickup(admin, { p1: '15', p2: '60', p3: '', p4: '' });
  expect(await readPickup(admin)).toEqual({ p1: 15, p2: 60, p3: null, p4: null });
  // Хранится только заданное: функция срока берёт остальное из срока первого ответа.
  expect(await stored()).toEqual({ p1: 15, p2: 60 });
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'settings.changed' and object_id = 'lines.pickup_minutes'`)).rows[0].n).toBe(1);
  await savePickup(admin, { p1: '', p2: '', p3: '', p4: '' });
  expect(await readPickup(admin)).toEqual({ p1: null, p2: null, p3: null, p4: null });
});

test('не администратор, старая сессия и негодные значения: настройка не меняется', async () => {
  const admin = staffCtx(f.adminStaff);
  await expect(readPickup(staffCtx(f.l1))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(savePickup(staffCtx(f.l1), { p1: '15', p2: '', p3: '', p4: '' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(savePickup({ ...admin, sessionCreatedAt: new Date(Date.now() - 901e3) }, { p1: '15', p2: '', p3: '', p4: '' })).rejects.toMatchObject({ code: 'stale_session' });
  for (const bad of ['0', '-5', '1.5', 'abc', '100001'])
    await expect(savePickup(admin, { p1: bad, p2: '', p3: '', p4: '' }), bad).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await stored()).toBeNull();
});
