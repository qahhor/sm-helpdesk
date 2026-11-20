import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { createWithIdentity, withIdentity } from '@/db/with-identity';
import { authUser } from '@/modules/hdu/auth-schema';
import { admin, clientA, pools } from './helpers/db';

const need = (name: string) => process.env[name] as string;

test('hub_app не видит таблицы аутентификации', async () => {
  for (const table of ['user', 'session', 'account', 'verification', 'twoFactor', 'ssoProvider'])
    await expect(pools.app.query(`select 1 from auth."${table}"`)).rejects.toThrow(/permission denied/);
});

test('hub_auth работает с таблицами auth, но не меняет схему и не видит таблицы приложения', async () => {
  const r = await pools.auth.query(
    `insert into auth."user" (name, email, "emailVerified") values ('Тест', 'schema-test@example.test', false) returning id`,
  );
  // Идентификатор задаёт база: uuid версии 7.
  expect(r.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await expect(pools.auth.query('create table auth.x (id int)')).rejects.toThrow(/permission denied/);
  await expect(pools.auth.query('drop table auth."user"')).rejects.toThrow(/must be owner/);
  await expect(pools.auth.query('select 1 from hdr_product_modules')).rejects.toThrow(/permission denied/);
});

test('адрес пользователя уникален и хранится в нижнем регистре', async () => {
  const insert = (email: string) =>
    pools.auth.query(`insert into auth."user" (name, email, "emailVerified") values ('u', $1, false)`, [email]);
  await insert('same@example.test');
  await expect(insert('same@example.test')).rejects.toThrow(/user_email_key/);
  await expect(insert('Upper@Example.Test')).rejects.toThrow(/user_c1/);
});

test('одна пара "сервер и идентификатор" принадлежит одной учётной записи', async () => {
  const user = async (email: string) =>
    (
      await pools.auth.query(
        `insert into auth."user" (name, email, "emailVerified") values ('u', $1, false) returning id`,
        [email],
      )
    ).rows[0].id as string;
  const link = (userId: string) =>
    pools.auth.query(
      `insert into auth.account ("accountId", "providerId", "userId", "updatedAt") values ('1001', 'cloud', $1, now())`,
      [userId],
    );
  await link(await user('pair-a@example.test'));
  await expect(link(await user('pair-b@example.test'))).rejects.toThrow(/account_provider_account_u1/);
});

test('удаление пользователя убирает его сессии, способы входа и второй фактор', async () => {
  const id = (
    await pools.auth.query(
      `insert into auth."user" (name, email, "emailVerified") values ('u', 'cascade@example.test', true) returning id`,
    )
  ).rows[0].id as string;
  await pools.auth.query(
    `insert into auth.session ("expiresAt", token, "updatedAt", "userId") values (now() + interval '1 day', 't-cascade', now(), $1)`,
    [id],
  );
  await pools.auth.query(`insert into auth."twoFactor" (secret, "backupCodes", "userId") values ('s', 'b', $1)`, [id]);
  await pools.auth.query(`delete from auth."user" where id = $1`, [id]);
  expect((await pools.auth.query(`select 1 from auth.session where "userId" = $1`, [id])).rowCount).toBe(0);
  expect((await pools.auth.query(`select 1 from auth."twoFactor" where "userId" = $1`, [id])).rowCount).toBe(0);
});

test('withIdentity передаёт актора базе под ролью hub_auth и не оставляет его в соединении', async () => {
  const one = new Pool({ connectionString: need('DATABASE_URL_AUTH'), max: 1 });
  try {
    const seen = await createWithIdentity(drizzle(one))(admin, async (tx) => {
      const r = await tx.execute(
        'select app.actor_type() as t, app.staff_role() as r, app.user_id() as u, current_user::text as who',
      );
      return r.rows[0];
    });
    expect(seen).toEqual({ t: 'staff', r: 'admin', u: admin.userId, who: 'hub_auth' });
    expect((await one.query('select app.actor_type() as t, app.user_id() as u')).rows[0]).toEqual({ t: 'none', u: null });
  } finally {
    await one.end();
  }
});

test('значения актора не остаются после ошибки внутри транзакции идентичности', async () => {
  const one = new Pool({ connectionString: need('DATABASE_URL_AUTH'), max: 1 });
  try {
    await expect(
      createWithIdentity(drizzle(one))(clientA, async () => {
        throw new Error('сбой сервиса');
      }),
    ).rejects.toThrow('сбой сервиса');
    expect((await one.query('select app.actor_type() as t, app.org_id()::text as o')).rows[0]).toEqual({ t: 'none', o: null });
  } finally {
    await one.end();
  }
});

test('withIdentity отдаёт исходную ошибку базы без значений параметров', async () => {
  const insert = () =>
    withIdentity(admin, (tx) =>
      tx.insert(authUser).values({ name: 'u', email: 'dup-secret-value@example.test', emailVerified: false }),
    );
  await insert();
  const error = (await insert().catch((e) => e)) as { code?: string; constraint?: string; message: string };
  expect(error.code).toBe('23505');
  expect(error.constraint).toBe('user_email_key');
  expect(error.message).not.toContain('dup-secret-value');
});

test('у каждой таблицы схемы auth есть комментарий', async () => {
  const r = await pools.owner.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') is null`);
  expect(r.rows).toEqual([]);
});

test('свои колонки в таблицах библиотеки описаны', async () => {
  const r = await pools.owner.query(`select a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relkind = 'r'
      and a.attname in ('claimedEmail', 'onboardedAt', 'lastOrgId', 'activeOrgId', 'locale', 'policyVersion')
      and col_description(c.oid, a.attnum) is null`);
  expect(r.rows).toEqual([]);
});
