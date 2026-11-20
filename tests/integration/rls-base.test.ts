import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { createWithActor, withActor } from '@/db/with-actor';
import { appSettings } from '@/modules/hdc/schema';
import { productModules } from '@/modules/hdr/schema';
import { admin, agentL1, appUrl, clientA, pools, system } from './helpers/db';

test('у каждой таблицы предметной области RLS включён и принудителен', async () => {
  const r = await pools.owner.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not (c.relrowsecurity and c.relforcerowsecurity)`);
  expect(r.rows).toEqual([]);
});

test('у каждой таблицы предметной области есть хотя бы одна политика', async () => {
  const r = await pools.owner.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`);
  expect(r.rows).toEqual([]);
});

test('у каждой таблицы и каждой колонки есть комментарий (docs/naming.md)', async () => {
  const tables = await pools.owner.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and obj_description(c.oid, 'pg_class') is null`);
  expect(tables.rows).toEqual([]);
  const columns = await pools.owner.query(`
    select c.relname || '.' || a.attname as col
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      and col_description(c.oid, a.attnum) is null`);
  expect(columns.rows).toEqual([]);
});

test('запрос без актора не возвращает ничего', async () => {
  await withActor(admin, (tx) => tx.insert(productModules).values({ code: 'orders', name: { ru: 'Заказы' } }));
  const r = await pools.app.query('select * from hdr_product_modules');
  expect(r.rows).toEqual([]);
});

test('запись без актора отклоняется', async () => {
  await expect(
    pools.app.query(`insert into hdr_product_modules (code, name) values ('x', '{"ru":"x"}')`),
  ).rejects.toThrow(/row-level security/);
});

test('значения актора не переходят в следующую транзакцию того же соединения', async () => {
  const one = new Pool({ connectionString: appUrl, max: 1 });
  try {
    await createWithActor(drizzle(one))(admin, (tx) => tx.select().from(appSettings));
    const r = await one.query('select app.actor_type() as t, app.staff_role() as s, app.user_id() as u');
    expect(r.rows[0]).toEqual({ t: 'none', s: null, u: null });
  } finally {
    await one.end();
  }
});

test('значения актора не остаются после ошибки внутри транзакции', async () => {
  const one = new Pool({ connectionString: appUrl, max: 1 });
  try {
    await expect(
      createWithActor(drizzle(one))(admin, async () => {
        throw new Error('сбой сервиса');
      }),
    ).rejects.toThrow('сбой сервиса');
    const r = await one.query('select app.actor_type() as t');
    expect(r.rows[0]).toEqual({ t: 'none' });
  } finally {
    await one.end();
  }
});

test('каждый вид актора виден базе своими значениями', async () => {
  const read = (actor: Parameters<typeof withActor>[0]) =>
    withActor(actor, async (tx) => {
      const r = await tx.execute(
        'select app.actor_type() as type, app.user_id() as user_id, app.org_id()::text as org_id, app.org_role() as org_role, app.staff_role() as staff_role, app.is_internal() as internal',
      );
      return r.rows[0];
    });
  expect(await read(clientA)).toEqual({
    type: 'client', user_id: clientA.userId, org_id: clientA.orgId, org_role: 'client_user', staff_role: null, internal: false,
  });
  expect(await read(agentL1)).toEqual({
    type: 'staff', user_id: agentL1.userId, org_id: null, org_role: null, staff_role: 'agent_l1', internal: true,
  });
  expect(await read(system)).toEqual({
    type: 'system', user_id: null, org_id: null, org_role: null, staff_role: null, internal: true,
  });
  expect(await read({ type: 'agent', tokenId: 'tok_1', tools: [] })).toEqual({
    type: 'agent', user_id: null, org_id: null, org_role: null, staff_role: null, internal: false,
  });
});

test('ошибка в сервисе откатывает запись', async () => {
  await expect(
    withActor(admin, async (tx) => {
      await tx.insert(productModules).values({ code: 'rollback', name: { ru: 'Откат' } });
      throw new Error('сбой после вставки');
    }),
  ).rejects.toThrow('сбой после вставки');
  expect(await withActor(admin, (tx) => tx.select().from(productModules))).toEqual([]);
});
