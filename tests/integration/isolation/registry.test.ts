import { expect, test } from 'vitest';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';
import { DOMAIN_OBJECTS, type Write } from './tables';

// Строки во все таблицы, чтобы "пусто" означало "закрыто политикой", а не "в таблице ничего нет".
async function seedEverything() {
  const f = await seedTwoOrgs();
  await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}')`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true')`);
  await pools.root.query(`insert into hdr_business_calendars (code, timezone, week_hours) values ('default', 'Asia/Tashkent', '{"0": null}')`);
  await pools.root.query(`insert into hdt_saved_filters (owner_id, name, query) values ($1, 'Мои', '{"queue": "mine"}')`, [f.l1.userId]);
  await pools.root.query(`insert into hdt_ticket_reads (ticket_id, user_id, seen_on) values ($1, $2, now())`, [f.tickets.aOrg.ticketId, f.l1.userId]);
  await pools.root.query(
    `insert into hdt_ticket_line_transfers (ticket_id, from_line, to_line, reason_code, checked, needed, by_user, pickup_due_on)
     values ($1, 'l1', 'l2', 'other', 'Проверено', 'Нужно', $2, now())`,
    [f.tickets.aOrg.ticketId, f.l1.userId],
  );
  await pools.root.query(`insert into hdr_reply_templates (shortcut, title, body) values ('greet', 'Приветствие', '{"ru": "Здравствуйте"}')`);
  await pools.root.query(`insert into hdr_l1_playbooks (ticket_type, body, owner_id) values ('bug', '- Версия', $1)`, [f.care.userId]);
  await pools.root.query(`insert into hdt_reply_drafts (ticket_id, user_id, body) values ($1, $2, 'Черновик')`, [f.tickets.aOrg.ticketId, f.l1.userId]);
  await pools.root.query(`insert into hdt_ticket_presence (ticket_id, user_id, mode, expires_on) values ($1, $2, 'viewing', now() + interval '1 minute')`, [
    f.tickets.aOrg.ticketId,
    f.l1.userId,
  ]);
  await pools.root.query(
    `insert into hdt_mentions (message_id, user_id) select message_id, $2 from hdt_ticket_messages where ticket_id = $1 and is_internal limit 1`,
    [f.tickets.aOrg.ticketId, f.care.userId],
  );
  await pools.root.query(
    `insert into hdr_sla_policies (priority, first_response_minutes, resolution_minutes, calendar_id) select 'p1', 15, 180, calendar_id from hdr_business_calendars`,
  );
  await pools.root.query(
    `insert into hdc_audit_log (org_id, actor_type, action, object_type) values ($1, 'system', 'org.provisioned', 'organization')`,
    [f.orgA.orgId],
  );
  await pools.root.query(`insert into hdc_rate_limits (code, window_on, hits) values ('x:1', now(), 1)`);
  await pools.root.query(`insert into hdc_ops_alerts (code, last_sent_on) values ('outbox_failed', now())`);
  await pools.root.query(
    `insert into hdu_email_tokens (user_id, email, token_hash, expires_on)
     values ($1, 'a@acme.test', encode(sha256('t'::bytea), 'hex'), now() + interval '1 hour')`,
    [f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdu_contact_identities (user_id, kind, external_id, display_name, verified, verified_on)
     values ($1, 'telegram', '777001', '@a', 'linked', now()), ($2, 'telegram', '777002', '@b', 'linked', now())`,
    [f.aUser.userId, f.bUser.userId],
  );
  await pools.root.query(
    `insert into hdu_link_codes (user_id, kind, code_hash, expires_on) values ($1, 'telegram', encode(sha256('l'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdu_login_codes (user_id, channel, code_hash, expires_on) values ($1, 'telegram', encode(sha256('g'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(`insert into hdn_telegram_updates (update_id) values (1)`);
  await pools.root.query(
    `with tag as (insert into hdr_tags (name, color) values ('Срочно', 'red') returning tag_id)
     insert into hdt_ticket_tags (org_id, ticket_id, tag_id, added_by) select $1, $2, tag_id, $3 from tag`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId, f.l1.userId],
  );
  await pools.root.query(`insert into hdu_server_checks (server_id, is_ok, issues) values ($1, false, '{timeout}')`, [f.server.serverId]);
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
  const people = new Set(
    (await pools.root.query(`select user_id from hdu_memberships where org_id = $1 union select user_id from hdu_staff where state = 'active'`, [f.orgA.orgId])).rows.map(
      (row) => row.user_id as string,
    ),
  );
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    let seen = 0;
    for (const actor of [f.aUser.actor, f.aAdmin.actor]) {
      // Столбец, по которому видно принадлежность. Не select *: у hub_app нет права на секретные столбцы
      // (например, хеш токена приглашения), и отказ выглядел бы как "клиент ничего не видит".
      const column = { none: '1', all: '1', 'own-org': 'org_id', 'org-people': 'user_id', 'own-user': 'user_id' }[rule.client];
      const rows = await rowsOrDenied(asActor(pools.app, actor, (c) => c.query(`select ${column} from ${name}`)));
      seen += rows.length;
      const label = `${name} для ${actor.orgRole}`;
      if (rule.client === 'none') expect(rows, label).toEqual([]);
      if (rule.client === 'all') expect(rows.length, label).toBeGreaterThan(0);
      if (rule.client === 'own-org') expect(rows.filter((row) => row.org_id !== f.orgA.orgId), label).toEqual([]);
      if (rule.client === 'org-people') expect(rows.filter((row) => !people.has(row.user_id as string)), label).toEqual([]);
      if (rule.client === 'own-user') expect(rows.filter((row) => row.user_id !== actor.userId), label).toEqual([]);
    }
    // Проверка "только своё" ничего не значит, если клиент не видит вообще ничего (проверка main, Q2).
    if (rule.client !== 'none') expect(seen, `${name}: клиент видит свои строки`).toBeGreaterThan(0);
  }
});

const WRITES: Write[] = ['insert', 'update', 'delete'];

test('права ролей приложения на изменение совпадают с набором', async () => {
  const actual = await pools.owner.query(`select c.relname as name, r.role, lower(p.priv) as priv
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('hub_app'), ('hub_auth')) r(role) cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(r.role, c.oid, p.priv)`);
  const granted = (name: string, role: string) =>
    actual.rows.filter((row) => row.name === name && row.role === role).map((row) => row.priv as Write).sort();
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS)) {
    expect(granted(name, 'hub_app'), `${name} hub_app`).toEqual([...(rule.app ?? [])].sort());
    expect(granted(name, 'hub_auth'), `${name} hub_auth`).toEqual([...(rule.auth ?? [])].sort());
  }
});

test('изменения, которых нет в наборе, закрыты при любом акторе', async () => {
  const f = await seedEverything();
  const actors = [f.aAdmin.actor, f.adminStaff.actor, { type: 'system', job: 'test' } as const];
  // Первый столбец каждого объекта: обновление без изменения значения, только проверка права.
  const firstColumn = new Map(
    (
      await pools.owner.query(`select table_name, column_name from information_schema.columns where table_schema = 'public' and ordinal_position = 1`)
    ).rows.map((row) => [row.table_name as string, row.column_name as string]),
  );
  const statement = {
    update: (t: string) => `update ${t} set ${firstColumn.get(t)} = ${firstColumn.get(t)}`,
    delete: (t: string) => `delete from ${t}`,
  };
  for (const [name, rule] of Object.entries(DOMAIN_OBJECTS))
    for (const [role, pool, allowed] of [
      ['hub_app', pools.app, rule.app ?? []],
      ['hub_auth', pools.auth, rule.auth ?? []],
    ] as const)
      for (const write of WRITES.filter((w) => w !== 'insert' && !allowed.includes(w)) as ('update' | 'delete')[])
        for (const actor of actors)
          await expect(
            asActor(pool, actor, (c) => c.query(statement[write](name))),
            `${write} ${name} под ${role}`,
          ).rejects.toThrow(/permission denied|cannot (update|delete from) view/);
  expect(f.orgA.orgId).not.toBe(f.orgB.orgId);
});
