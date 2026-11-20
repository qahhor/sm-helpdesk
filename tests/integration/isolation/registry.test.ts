import { expect, test } from 'vitest';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { DOMAIN_OBJECTS } from './tables';

// Строки во все таблицы, чтобы "пусто" означало "закрыто политикой", а не "в таблице ничего нет".
async function seedEverything() {
  const f = await seedTwoOrgs();
  await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}')`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true')`);
  await pools.root.query(
    `insert into hdc_audit_log (org_id, actor_type, action, object_type) values ($1, 'system', 'org.provisioned', 'organization')`,
    [f.orgA.orgId],
  );
  await pools.root.query(`insert into hdc_rate_limits (code, window_on, hits) values ('x:1', now(), 1)`);
  await pools.root.query(
    `insert into hdu_email_tokens (user_id, email, token_hash, expires_on)
     values ($1, 'a@acme.test', encode(sha256('t'::bytea), 'hex'), now() + interval '1 hour')`,
    [f.aUser.userId],
  );
  return f;
}

const rowsOrDenied = (query: Promise<{ rows: Record<string, unknown>[] }>) =>
  query.then(
    (result) => result.rows,
    (error) => {
      expect(String(error)).toMatch(/permission denied/);
      return [] as Record<string, unknown>[];
    },
  );

test('у каждой таблицы и представления предметной области есть строка в наборе изоляции', async () => {
  const r = await pools.owner.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by 1`);
  expect(r.rows.map((x) => x.relname)).toEqual(Object.keys(DOMAIN_OBJECTS).sort());
});

test('в каждой таблице набора есть данные для проверки', async () => {
  await seedEverything();
  for (const name of Object.keys(DOMAIN_OBJECTS)) {
    // Представление само отбирает строки по актору, поэтому без актора пусто даже у суперпользователя.
    const found =
      name === 'hdu_user_profiles'
        ? await asActor(pools.app, { type: 'system', job: 'test' }, (c) => c.query(`select 1 from ${name} limit 1`))
        : await pools.root.query(`select 1 from ${name} limit 1`);
    expect(found.rowCount, name).toBe(1);
  }
});

test('запрос без актора не возвращает ни одной строки ни под одной ролью приложения', async () => {
  await seedEverything();
  for (const name of Object.keys(DOMAIN_OBJECTS))
    for (const [role, pool] of [
      ['hub_app', pools.app],
      ['hub_auth', pools.auth],
    ] as const)
      expect(await rowsOrDenied(pool.query(`select * from ${name}`)), `${name} без актора под ролью ${role}`).toEqual([]);
});

test('клиент видит в каждой таблице ровно то, что записано в наборе', async () => {
  const f = await seedEverything();
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS))
    for (const actor of [f.aUser.actor, f.aAdmin.actor]) {
      const rows = await rowsOrDenied(asActor(pools.app, actor, (c) => c.query(`select * from ${name}`)));
      const label = `${name} для ${actor.orgRole}`;
      if (rule.client === 'none') expect(rows, label).toEqual([]);
      if (rule.client === 'all') expect(rows.length, label).toBeGreaterThan(0);
      if (rule.client === 'own-org')
        expect(rows.filter((row) => 'org_id' in row && row.org_id !== f.orgA.orgId), label).toEqual([]);
    }
});

test('приложение под ролью hub_app не меняет таблицы идентичности ни при каком акторе', async () => {
  const f = await seedEverything();
  const tables = ['hdu_servers', 'hdu_organizations', 'hdu_memberships', 'hdu_staff', 'hdu_invitations', 'hdu_email_tokens'];
  for (const table of tables)
    for (const actor of [f.aAdmin.actor, f.adminStaff.actor, { type: 'system', job: 'test' } as const]) {
      const run = (sql: string) => asActor(pools.app, actor, (c) => c.query(sql));
      await expect(run(`update ${table} set modified_on = now()`), `update ${table}`).rejects.toThrow(/permission denied/);
      await expect(run(`delete from ${table}`), `delete ${table}`).rejects.toThrow(/permission denied/);
    }
});

test('удалить строку идентичности не может и роль hub_auth', async () => {
  const f = await seedEverything();
  for (const table of ['hdu_servers', 'hdu_organizations', 'hdu_memberships', 'hdu_staff', 'hdu_invitations', 'hdu_email_tokens'])
    await expect(
      asActor(pools.auth, { type: 'system', job: 'test' }, (c) => c.query(`delete from ${table}`)),
      table,
    ).rejects.toThrow(/permission denied/);
  expect(f.orgA.orgId).not.toBe(f.orgB.orgId);
});
