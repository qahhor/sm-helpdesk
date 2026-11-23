import { beforeEach, expect, test } from 'vitest';
import { listPresence, syncPresence } from '@/modules/hdt/api';
import { staffCtx } from './helpers/auth';
import { captureQueries, countTransactions } from './helpers/bulk';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Присутствие одним запросом (аудит 23.11.2026, находка P12; план W2, задача 7). Страница обращения отмечается
// раз в 10 секунд на каждую открытую вкладку: раньше это были отметка, список и имена, по транзакции на каждое.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

test('отметка и список коллег: одна транзакция и одна команда, когда на обращении никого больше нет', async () => {
  const l1 = staffCtx(f.l1);
  const number = f.tickets.aOrg.number;
  const counted = await countTransactions(() => syncPresence(l1, { number, mode: 'viewing' }));
  expect(counted.result).toEqual([]);
  expect([counted.app, counted.auth]).toEqual([1, 0]);
  const { queries } = await captureQueries(() => syncPresence(l1, { number, mode: 'typing' }));
  expect(queries.filter((q) => /hdt_ticket_presence/.test(q.text))).toHaveLength(1);
  expect((await pools.root.query(`select mode, expires_on > now() + interval '50 seconds' as fresh from hdt_ticket_presence where user_id = $1`, [f.l1.userId])).rows).toEqual([{ mode: 'typing', fresh: true }]);
});

test('коллега на том же обращении виден по имени; своя отметка в список не входит; истёкшая не показывается', async () => {
  const number = f.tickets.aOrg.number;
  await syncPresence(staffCtx(f.care), { number, mode: 'typing' });
  const counted = await countTransactions(() => syncPresence(staffCtx(f.l1), { number, mode: 'viewing' }));
  expect(counted.result).toEqual([{ userId: f.care.userId, name: 'Камила', mode: 'typing' }]);
  // Имена читает модуль пользователей: ещё одна транзакция, только когда есть кого назвать.
  expect(counted.app + counted.auth).toBeLessThanOrEqual(2);
  expect(await listPresence(staffCtx(f.care), number)).toEqual([{ userId: f.l1.userId, name: 'Азиз', mode: 'viewing' }]);
  await pools.root.query(`update hdt_ticket_presence set expires_on = now() - interval '1 second' where user_id = $1`, [f.care.userId]);
  expect(await syncPresence(staffCtx(f.l1), { number, mode: 'viewing' })).toEqual([]);
});

test('несуществующее обращение: пустой список, отметка не создаётся', async () => {
  expect(await syncPresence(staffCtx(f.l1), { number: 999_999_999, mode: 'viewing' })).toEqual([]);
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_presence`)).rows[0].n).toBe(0);
});
