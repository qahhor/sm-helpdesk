import { beforeEach, expect, test } from 'vitest';
import { listQueue, listTickets } from '@/modules/hdt/api';
import { searchOrganizations } from '@/modules/hdu/api/orgs';
import { findOrgIds, findUserIds } from '@/modules/hdu/api/staff-lookup';
import { clientCtx, staffCtx } from './helpers/auth';
import { captureQueries } from './helpers/bulk';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Поиск (аудит 23.11.2026, находка P9; план W2, задача 4). Запрос из одного-двух знаков совпадает почти со всем
// и не может идти по индексу: он не ищется, человек получает подсказку. Название и ИНН организации, имя и адрес
// человека ищутся по индексам.

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
});

test('очередь сотрудника: запрос короче 3 знаков не ищет и говорит об этом; номер ищется при любой длине', async () => {
  const l1 = staffCtx(f.l1);
  const short = await listQueue(l1, { queue: 'all', q: 'от' });
  expect(short).toMatchObject({ items: [], hasMore: false, searchTooShort: true });
  const one = await captureQueries(() => listQueue(l1, { queue: 'all', q: 'о' }));
  expect(one.result.searchTooShort).toBe(true);
  // К базе за обращениями и людьми такой запрос не идёт вовсе.
  expect(one.queries.filter((q) => /hdt_tickets|hdu_organizations|auth\."user"/.test(q.text))).toEqual([]);
  const byNumber = await listQueue(l1, { queue: 'all', q: String(f.tickets.aOrg.number) });
  expect(byNumber.searchTooShort).toBe(false);
  expect(byNumber.items.map((row) => row.number)).toContain(f.tickets.aOrg.number);
  const byText = await listQueue(l1, { queue: 'all', q: 'Отчёт' });
  expect(byText.searchTooShort).toBe(false);
  expect(byText.items.length).toBeGreaterThan(0);
  expect((await listQueue(l1, { queue: 'all' })).searchTooShort).toBe(false);
});

test('список клиента: запрос короче 3 знаков не ищет и говорит об этом', async () => {
  const ctx = await clientCtx(f.aUser);
  expect(await listTickets(ctx, { q: 'от' })).toMatchObject({ items: [], nextCursor: null, searchTooShort: true });
  const found = await listTickets(ctx, { q: 'Отчёт' });
  expect(found.searchTooShort).toBe(false);
  expect(found.items.length).toBeGreaterThan(0);
  expect((await listTickets(ctx, { q: `SUP-${f.tickets.aOrg.number}` })).items).toHaveLength(1);
});

test('организации: короткий запрос не ищет, пустой показывает все', async () => {
  const care = staffCtx(f.care);
  expect(await searchOrganizations(care, { query: 'AC' })).toMatchObject({ items: [], hasMore: false, searchTooShort: true });
  expect((await searchOrganizations(care, {})).items.length).toBeGreaterThanOrEqual(2);
  expect((await searchOrganizations(care, { query: f.orgA.name.slice(0, 4) })).searchTooShort).toBe(false);
  expect(await findOrgIds(care, 'AC')).toEqual([]);
  expect(await findUserIds(care, 'ан')).toEqual([]);
});

/** План запроса под ролью приложения или входа. */
async function plan(pool: 'app' | 'auth', actor: Fixture['care']['actor'], text: string, values: unknown[]): Promise<string> {
  return asActor(pool === 'app' ? pools.app : pools.auth, actor, async (client) =>
    (await client.query({ text: `explain (costs off) ${text}`, values })).rows.map((row) => Object.values(row)[0]).join('\n'),
  );
}

test('поиск человека по имени и адресу идёт по индексам; организация находится по названию, ИНН и идентификатору компании', async () => {
  const root = await pools.root.connect();
  try {
    await root.query(`set session_replication_role = replica`);
    await root.query(
      `insert into hdu_organizations (org_id, server_id, external_company_id, name, inn)
       select uuidv7(), $1, 'bulk-' || g, 'Организация ' || md5(g::text), lpad((300000000 + g)::text, 9, '0') from generate_series(1, 20000) g`,
      [f.server.serverId],
    );
    await root.query(
      `insert into auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       select uuidv7(), 'Человек ' || md5(g::text), 'bulk' || g || '@' || md5(g::text) || '.example', true, now(), now() from generate_series(1, 100000) g`,
    );
    await root.query(`set session_replication_role = origin`);
    await root.query(`analyze hdu_organizations`);
    await root.query(`analyze auth."user"`);
  } finally {
    await root.query(`set session_replication_role = origin`).catch(() => undefined);
    root.release();
  }
  const care = staffCtx(f.care);
  // Люди ищутся под ролью входа, у таблицы пользователей политик RLS нет: индекс работает.
  const userPlan = await plan(
    'auth',
    f.care.actor,
    `select "id" from auth."user" where ("name" ilike $1 or ("emailVerified" = true and "email" ilike $1)) limit 200`,
    ['%a1b2c3%'],
  );
  expect(userPlan, userPlan).not.toMatch(/Seq Scan on "?user"?/);
  expect(userPlan, userPlan).toMatch(/Bitmap Index Scan on user_(name|email)_trgm_idx/);
  expect((await findUserIds(care, 'bulk777@')).length).toBe(1);
  // Организации находятся по всем трём полям. Под политиками RLS поиск идёт просмотром таблицы (решение 0039,
  // пункт 6): здесь проверяется только результат.
  expect(await findOrgIds(care, '300012345')).toHaveLength(1);
  expect((await searchOrganizations(care, { query: '300012345' })).items).toHaveLength(1);
  expect((await searchOrganizations(care, { query: 'bulk-12345' })).items).toHaveLength(1);
  expect((await searchOrganizations(care, { query: 'Организация c4ca4238' })).items).toHaveLength(1);
}, 240_000);
