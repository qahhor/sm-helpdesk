import { expect, test } from 'vitest';
import { resolveClient } from '@/modules/hdu/api/orgs';
import { resolveStaff } from '@/modules/hdu/api/session';
import { listMySessions, revokeMySession, revokeOtherSessions, SESSION_LIST_LIMIT } from '@/modules/hdu/api/sessions';
import { clientSession, reload } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Сессии пользователя: список и завершение на другом устройстве (ТЗ 14.3).

test('пользователь видит свои сессии без токенов, текущая отмечена и стоит первой', async () => {
  const f = await seedTwoOrgs();
  const first = await clientSession(f.aUser);
  const second = await clientSession(f.aUser);
  await clientSession(f.bUser);
  await pools.root.query(`update auth.session set "userAgent" = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36', "ipAddress" = '203.0.113.7' where id = $1`, [
    second.session.id,
  ]);
  const list = (await listMySessions(first)).items;
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ sessionId: first.session.id, isCurrent: true });
  expect(list[1]).toMatchObject({ sessionId: second.session.id, isCurrent: false, browser: 'chrome', os: 'windows', ip: '203.0.113.7' });
  expect(list[1]?.createdOn).toBeInstanceOf(Date);
  expect(JSON.stringify(list)).not.toContain(first.session.token);
  expect(JSON.stringify(list)).not.toContain(second.session.token);
});

test('отозванная сессия не действует на следующем запросе', async () => {
  const f = await seedTwoOrgs();
  const first = await clientSession(f.aUser);
  const second = await clientSession(f.aUser);
  expect(await revokeMySession(first, second.session.id)).toEqual({ signedOut: false });
  expect(await reload(second)).toBeNull();
  expect(await resolveClient(await reload(second))).toEqual({ denied: 'no_session' });
  expect(await resolveClient((await reload(first))!)).toMatchObject({ actor: { userId: f.aUser.userId } });
});

test('чужую сессию отозвать нельзя, ответ как для несуществующей', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.aUser);
  const other = await clientSession(f.bUser);
  await expect(revokeMySession(mine, other.session.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(revokeMySession(mine, '019a0000-0000-7000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  await expect(revokeMySession(mine, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await resolveClient((await reload(other))!)).toMatchObject({ actor: { userId: f.bUser.userId } });
});

test('отзыв текущей сессии равен выходу', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.aUser);
  expect(await revokeMySession(mine, mine.session.id)).toEqual({ signedOut: true });
  expect(await reload(mine)).toBeNull();
});

test('истёкшие сессии в списке не показываются', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.aUser);
  const old = await clientSession(f.aUser);
  await pools.root.query(`update auth.session set "expiresAt" = now() - interval '1 minute' where id = $1`, [old.session.id]);
  expect((await listMySessions(mine)).items.map((s) => s.sessionId)).toEqual([mine.session.id]);
});

test('завершение сессии сотрудником пишется в журнал, клиентом нет', async () => {
  const f = await seedTwoOrgs();
  const staffFirst = await clientSession(f.care);
  const staffSecond = await clientSession(f.care);
  await revokeMySession(staffFirst, staffSecond.session.id, '203.0.113.71');
  // Адрес запроса в записи журнала (итоговая проверка доработки, замечание 8).
  expect((await pools.root.query(`select host(ip) as ip from hdc_audit_log where action = 'session.revoked'`)).rows).toEqual([{ ip: '203.0.113.71' }]);
  const clientFirst = await clientSession(f.aUser);
  const clientSecond = await clientSession(f.aUser);
  await revokeMySession(clientFirst, clientSecond.session.id);
  expect((await pools.root.query(`select actor_id, object_id from hdc_audit_log where action = 'session.revoked'`)).rows).toEqual([
    { actor_id: f.care.userId, object_id: staffSecond.session.id },
  ]);
  // Завершённая сессия сотрудника тоже не пускает.
  expect(await resolveStaff(await reload(staffSecond), new Date())).toEqual({ denied: 'no_session' });
});

test('список показывает не больше 20 последних сессий и говорит, сколько ещё', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.aUser);
  for (let i = 0; i < 24; i++) await clientSession(f.aUser);
  // Текущая сессия самая старая, но в списке она первая.
  await pools.root.query(`update auth.session set "updatedAt" = now() - interval '1 day' where id = $1`, [mine.session.id]);
  const list = await listMySessions(mine);
  expect(SESSION_LIST_LIMIT).toBe(20);
  expect(list.items).toHaveLength(20);
  expect(list.items[0]).toMatchObject({ sessionId: mine.session.id, isCurrent: true });
  expect(list.hidden).toBe(5);
});

test('завершить все другие сессии: текущая остаётся, остальные перестают действовать', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.aUser);
  const others = [await clientSession(f.aUser), await clientSession(f.aUser)];
  const stranger = await clientSession(f.bUser);
  expect(await revokeOtherSessions(mine)).toEqual({ revoked: 2 });
  for (const other of others) expect(await reload(other)).toBeNull();
  expect(await reload(mine)).not.toBeNull();
  expect(await reload(stranger)).not.toBeNull();
  expect((await listMySessions(mine)).items.map((s) => s.sessionId)).toEqual([mine.session.id]);
});

test('сотрудник, завершивший все другие сессии, оставляет запись в журнале', async () => {
  const f = await seedTwoOrgs();
  const mine = await clientSession(f.care);
  await clientSession(f.care);
  await revokeOtherSessions(mine);
  expect((await pools.root.query(`select actor_id, object_id, diff from hdc_audit_log where action = 'session.revoked'`)).rows).toEqual([
    { actor_id: f.care.userId, object_id: f.care.userId, diff: { others: 1 } },
  ]);
});
