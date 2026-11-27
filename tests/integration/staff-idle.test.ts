import { beforeEach, expect, test } from 'vitest';
import { resolveClient } from '@/modules/hdu/api/orgs';
import { markStaffActivity, resolveStaff, staffAccess } from '@/modules/hdu/api/session';
import { STAFF_IDLE_SEC } from '@/modules/hdu/pref';
import type { SessionData } from '@/modules/hdu/api/request';
import { clientSession, reload } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Срок бездействия сотрудника (план M9, задача 4, решение 8; ASVS V7.3.1, FR-ID-10): 30 минут без действий человека
// закрывают сессию сотрудника, вход ведёт обратно на ту же страницу. Действием человека считается только отметка
// активности (страница её ставит по открытию и вводу), фоновые запросы и перерисовки срок не продлевают. Предел
// 12 часов от входа не сдвигается. Сессия клиента живёт по своим правилам.

const MINUTE = 60_000;
let f: Fixture;
let start: Date;

beforeEach(async () => {
  f = await seedTwoOrgs();
  start = new Date(Date.now() - 1000);
  await pools.root.query(`update auth."user" set "twoFactorEnabled" = true where id = $1`, [f.l1.userId]);
});

/** Сессия сотрудника после входа паролем с кодом в момент start. */
async function staffSession(): Promise<SessionData> {
  const id = (
    await pools.root.query(
      `insert into auth.session ("expiresAt", token, "createdAt", "updatedAt", "userId", "userAgent", "secondFactorAt", "freshAuthAt")
       values ($1::timestamptz + interval '12 hours', $2, $1, $1, $3, 'Test', $1, $1) returning id`,
      [start, `s-${Math.random().toString(36).slice(2)}`, f.l1.userId],
    )
  ).rows[0].id as string;
  return (await reload({ session: { id } } as SessionData)) as SessionData;
}
const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
const exists = async (session: SessionData) => (await pools.root.query(`select 1 from auth.session where id = $1`, [session.session.id])).rowCount === 1;

test('срок бездействия 30 минут', () => {
  expect(STAFF_IDLE_SEC).toBe(30 * 60);
});

test('29 минут без действий проходит, 31 минута закрывает сессию и ведёт на вход', async () => {
  const session = await staffSession();
  expect(await resolveStaff(session, at(29))).toMatchObject({ actor: { type: 'staff', userId: f.l1.userId } });
  const idle = await resolveStaff(session, at(31));
  expect(idle).toEqual({ denied: 'idle' });
  expect(staffAccess(idle)).toBe('sign_in');
  expect(await exists(session)).toBe(false);
});

test('фоновые запросы (перерисовка очереди, счётчики) срок не продлевают', async () => {
  const session = await staffSession();
  for (const minute of [5, 10, 15, 20, 25, 29]) expect('actor' in (await resolveStaff((await reload(session))!, at(minute)))).toBe(true);
  expect(await resolveStaff((await reload(session))!, at(31))).toEqual({ denied: 'idle' });
});

test('действие человека продлевает срок от себя; повтор в пределах минуты базу не трогает', async () => {
  const session = await staffSession();
  expect(await markStaffActivity(session, at(20))).toBe(true);
  expect(await markStaffActivity((await reload(session))!, at(20.5))).toBe(true);
  const stored = (await pools.root.query(`select "staffActiveAt" from auth.session where id = $1`, [session.session.id])).rows[0].staffActiveAt as Date;
  expect(stored.getTime()).toBe(at(20).getTime());
  expect('actor' in (await resolveStaff((await reload(session))!, at(49)))).toBe(true);
  expect(await resolveStaff((await reload(session))!, at(51))).toEqual({ denied: 'idle' });
});

test('после 30 минут бездействия отметка активности сессию не возвращает', async () => {
  const session = await staffSession();
  expect(await markStaffActivity(session, at(31))).toBe(false);
  expect(await exists(session)).toBe(false);
  expect(await markStaffActivity(null, at(1))).toBe(false);
});

test('предел 12 часов от входа не сдвигается активностью', async () => {
  const session = await staffSession();
  for (let minute = 25; minute <= 12 * 60 - 5; minute += 25) expect(await markStaffActivity((await reload(session))!, at(minute))).toBe(true);
  expect('actor' in (await resolveStaff((await reload(session))!, at(12 * 60 - 1)))).toBe(true);
  expect(await resolveStaff((await reload(session))!, at(12 * 60 + 1))).toEqual({ denied: 'expired' });
});

test('сессия клиента без действий два часа действует', async () => {
  const session = await clientSession(f.aUser);
  await pools.root.query(`update auth.session set "createdAt" = now() - interval '2 hours', "updatedAt" = now() - interval '2 hours' where id = $1`, [session.session.id]);
  expect(await resolveClient((await reload(session))!)).toMatchObject({ org: { id: f.orgA.orgId } });
  // Отметка активности сотрудника на сессии клиента ничего не делает.
  expect(await markStaffActivity((await reload(session))!, new Date())).toBe(false);
});
