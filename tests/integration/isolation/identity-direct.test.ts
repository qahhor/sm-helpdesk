import { expect, test } from 'vitest';
import type { Actor, AgentActor } from '@/db/with-actor';
import { asActor, pools } from '../helpers/db';
import { SEALED, seedTwoOrgs } from './fixture';
import { linkTelegramFixture } from '../helpers/telegram';

// Проверки политик запросами напрямую в базу, с переменными актора (ТЗ 15.2):
// так ошибка в политике видна, даже если сервис её маскирует.

const system = { type: 'system', job: 'test' } as const;
const rows = <T = Record<string, unknown>>(pool: typeof pools.app, actor: Actor, sql: string, params: unknown[] = []) =>
  asActor(pool, actor, (c) => c.query(sql, params)).then((r) => r.rows as T[]);
const count = (pool: typeof pools.app, actor: Actor, sql: string, params: unknown[] = []) =>
  asActor(pool, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);

test('клиент видит только свою действующую организацию, сотрудник видит все', async () => {
  const f = await seedTwoOrgs();
  const orgs = (actor: Actor) =>
    rows<{ org_id: string }>(pools.app, actor, 'select org_id from hdu_organizations').then((r) => r.map((x) => x.org_id));
  expect(await orgs(f.aUser.actor)).toEqual([f.orgA.orgId]);
  expect(await orgs(f.bAdmin.actor)).toEqual([f.orgB.orgId]);
  expect((await orgs(f.l1.actor)).sort()).toEqual([f.orgA.orgId, f.orgB.orgId].sort());
  await pools.root.query(`update hdu_organizations set state = 'passive' where org_id = $1`, [f.orgA.orgId]);
  expect(await orgs(f.aUser.actor)).toEqual([]);
  expect(await orgs(f.l1.actor)).toHaveLength(2);
});

test('клиент видит членство только своей организации', async () => {
  const f = await seedTwoOrgs();
  const mine = await rows<{ user_id: string }>(pools.app, f.aUser.actor, 'select user_id from hdu_memberships');
  expect(mine.map((r) => r.user_id).sort()).toEqual([f.aUser.userId, f.aAdmin.userId].sort());
});

test('клиент видит участников своей организации и сотрудников, но не чужих участников', async () => {
  const f = await seedTwoOrgs();
  const profiles = await rows<{ user_id: string; name: string; is_staff: boolean }>(
    pools.app,
    f.aUser.actor,
    'select * from hdu_user_profiles',
  );
  expect(profiles.map((r) => r.user_id).sort()).toEqual(
    [f.aUser.userId, f.aAdmin.userId, f.care.userId, f.l1.userId, f.adminStaff.userId].sort(),
  );
  expect(profiles.find((r) => r.user_id === f.care.userId)?.is_staff).toBe(true);
  expect(profiles.find((r) => r.user_id === f.aAdmin.userId)?.is_staff).toBe(false);
  // Только идентификатор, имя и признак сотрудника: адреса и прочих полей учётной записи нет.
  expect(Object.keys(profiles[0] ?? {}).sort()).toEqual(['is_staff', 'name', 'user_id']);
  expect(await rows(pools.app, f.l1.actor, 'select user_id from hdu_user_profiles')).toHaveLength(7);
});

test('отключённый участник остаётся в профилях своей организации: его имя стоит у старых записей', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId]);
  const ids = (await rows<{ user_id: string }>(pools.app, f.aAdmin.actor, 'select user_id from hdu_user_profiles')).map(
    (r) => r.user_id,
  );
  expect(ids).toContain(f.aUser.userId);
});

test('приглашения видит только администратор своей организации, без хеша токена', async () => {
  const f = await seedTwoOrgs();
  const list = (actor: Actor) => rows<{ org_id: string; email: string }>(pools.app, actor, 'select org_id, email from hdu_invitations');
  expect(await list(f.aUser.actor)).toEqual([]);
  expect(await list(f.aAdmin.actor)).toEqual([{ org_id: f.orgA.orgId, email: 'invited-a@acme.test' }]);
  expect(await list(f.care.actor)).toHaveLength(2);
  for (const actor of [f.aAdmin.actor, f.care.actor, f.adminStaff.actor])
    await expect(rows(pools.app, actor, 'select token_hash from hdu_invitations')).rejects.toThrow(/permission denied/);
});

test('реестр серверов клиенту не виден, секрет не читается приложением ни при каком акторе', async () => {
  const f = await seedTwoOrgs();
  expect(await rows(pools.app, f.aAdmin.actor, 'select code from hdu_servers')).toEqual([]);
  expect(await rows(pools.app, f.adminStaff.actor, 'select code from hdu_servers')).toEqual([{ code: f.server.code }]);
  for (const column of ['oauth_client_secret', 'oauth_client_id', 'oidc_endpoints'])
    for (const actor of [f.adminStaff.actor, system])
      await expect(rows(pools.app, actor, `select ${column} from hdu_servers`), column).rejects.toThrow(/permission denied/);
  await expect(rows(pools.app, f.adminStaff.actor, 'select * from hdu_servers')).rejects.toThrow(/permission denied/);
});

test('секрет сервера в открытом виде в таблицу не записать', async () => {
  await expect(
    pools.root.query(`insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, code)
      values ('x', 'https://plain.example', 'https://plain.example', 'c', 'plain-text-secret', 'plain')`),
  ).rejects.toThrow(/hdu_servers_c/);
});

test('список сотрудников и токены подтверждения приложению под ролью hub_app недоступны', async () => {
  const f = await seedTwoOrgs();
  for (const table of ['hdu_staff', 'hdu_email_tokens'])
    for (const actor of [f.aAdmin.actor, f.adminStaff.actor, system])
      await expect(rows(pools.app, actor, `select * from ${table}`), table).rejects.toThrow(/permission denied/);
});

test('администратор клиента создаёт приглашение только в своей организации и только от своего имени', async () => {
  const f = await seedTwoOrgs();
  const invite = (orgId: string, invitedBy: string, role = 'client_user') =>
    count(
      pools.auth,
      f.aAdmin.actor,
      `insert into hdu_invitations (org_id, email, role, token_hash, invited_by, expires_on)
       values ($1, 'x@example.test', $2, encode(sha256(random()::text::bytea), 'hex'), $3, now() + interval '7 days')`,
      [orgId, role, invitedBy],
    );
  await expect(invite(f.orgB.orgId, f.aAdmin.userId)).rejects.toThrow(/row-level security/);
  await expect(invite(f.orgA.orgId, f.bAdmin.userId)).rejects.toThrow(/row-level security/);
  await expect(invite(f.orgA.orgId, f.aAdmin.userId, 'admin')).rejects.toThrow(/hdu_invitations_c/);
  expect(await invite(f.orgA.orgId, f.aAdmin.userId, 'client_admin')).toBe(1);
  // Обычный пользователь приглашать не может.
  await expect(
    count(
      pools.auth,
      f.aUser.actor,
      `insert into hdu_invitations (org_id, email, role, token_hash, invited_by, expires_on)
       values ($1, 'y@example.test', 'client_user', encode(sha256(random()::text::bytea), 'hex'), $2, now() + interval '7 days')`,
      [f.orgA.orgId, f.aUser.userId],
    ),
  ).rejects.toThrow(/row-level security/);
});

test('администратор клиента может только отозвать своё приглашение: остальное в нём менять нельзя', async () => {
  const f = await seedTwoOrgs();
  const update = (set: string, actor: Actor = f.aAdmin.actor) => count(pools.auth, actor, `update hdu_invitations set ${set}`);
  expect(await update('revoked_on = now()')).toBe(1); // только приглашение своей организации
  expect(
    (await pools.root.query(`select count(*)::int as n from hdu_invitations where revoked_on is not null`)).rows[0].n,
  ).toBe(1);
  await expect(update(`role = 'client_admin'`)).rejects.toThrow(/нельзя/);
  await expect(update(`email = 'other@example.test'`)).rejects.toThrow(/нельзя/);
  await expect(update(`expires_on = now() + interval '10 years'`)).rejects.toThrow(/нельзя/);
  await expect(update('accepted_on = now()')).rejects.toThrow(/нельзя/);
  // Отозванное приглашение не возвращается и отметка об отзыве не переписывается (итоговая проверка M1, мелкое 5).
  await expect(update('revoked_on = null')).rejects.toThrow(/нельзя/);
  await expect(update(`revoked_on = now() + interval '1 day'`)).rejects.toThrow(/нельзя/);
  expect(await update('revoked_on = now()', f.aUser.actor)).toBe(0);
});

test('администратор клиента не меняет роли и не трогает участников чужой организации', async () => {
  const f = await seedTwoOrgs();
  const run = (sql: string, params: unknown[]) => count(pools.auth, f.aAdmin.actor, sql, params);
  await expect(run(`update hdu_memberships set role = 'client_admin' where user_id = $1`, [f.aUser.userId])).rejects.toThrow(/нельзя/);
  await expect(run(`update hdu_memberships set source = 'staff' where user_id = $1`, [f.aUser.userId])).rejects.toThrow(/нельзя/);
  expect(await run(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.bUser.userId])).toBe(0);
  // Отключить коллегу в своей организации можно, себя нельзя.
  expect(await run(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId])).toBe(1);
  expect(await run(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aAdmin.userId])).toBe(0);
  expect(await count(pools.auth, f.aUser.actor, `update hdu_memberships set state = 'passive'`)).toBe(0);
  // Вставить членство клиент не может вообще.
  await expect(
    run(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_admin', 'invite')`, [
      f.orgA.orgId,
      f.bUser.userId,
    ]),
  ).rejects.toThrow(/row-level security/);
});

test('роль участника меняют только care и admin, организацию и пользователя в членстве не меняет никто', async () => {
  const f = await seedTwoOrgs();
  const promote = (actor: Actor) =>
    count(pools.auth, actor, `update hdu_memberships set role = 'client_admin', is_role_manual = true where user_id = $1`, [
      f.aUser.userId,
    ]);
  expect(await promote(f.l1.actor)).toBe(0);
  expect(await promote(f.care.actor)).toBe(1);
  expect(await promote(f.adminStaff.actor)).toBe(1);
  await expect(
    count(pools.auth, f.care.actor, `update hdu_memberships set org_id = $1 where user_id = $2`, [f.orgB.orgId, f.aUser.userId]),
  ).rejects.toThrow(/нельзя/);
  await expect(
    pools.root.query(`update hdu_memberships set user_id = $1 where user_id = $2`, [f.care.userId, f.aUser.userId]),
  ).rejects.toThrow(/нельзя/);
});

test('клиент и линии поддержки не пишут в реестр серверов, в организации и в список сотрудников', async () => {
  const f = await seedTwoOrgs();
  for (const actor of [f.aAdmin.actor, f.l1.actor, f.care.actor]) {
    expect(await count(pools.auth, actor, `update hdu_servers set name = 'x'`)).toBe(0);
    expect(await count(pools.auth, actor, `update hdu_server_checks set is_ok = true`)).toBe(0);
    expect(await count(pools.auth, actor, `update hdu_staff set role = 'admin'`)).toBe(0);
    await expect(
      count(pools.auth, actor, `insert into hdu_staff (user_id, role) values ($1, 'admin')`, [f.aUser.userId]),
    ).rejects.toThrow(/row-level security/);
  }
  for (const actor of [f.aAdmin.actor, f.l1.actor]) expect(await count(pools.auth, actor, `update hdu_organizations set name = 'x'`)).toBe(0);
  // Customer Care меняет у организации только категорию и признак AI (политика care_update и триггер guard, 0007).
  await expect(count(pools.auth, f.care.actor, `update hdu_organizations set name = 'x'`)).rejects.toThrow(/нельзя/);
  // Администратор портала ведёт реестр серверов.
  expect(await count(pools.auth, f.adminStaff.actor, `update hdu_servers set name = 'Новое имя'`)).toBe(1);
});

test('сотрудники меняют у организации только категорию и признак AI, остальное ведёт система', async () => {
  const f = await seedTwoOrgs();
  for (const actor of [f.care.actor, f.adminStaff.actor]) {
    expect(await count(pools.auth, actor, `update hdu_organizations set category = 'A', is_ai_enabled = false where org_id = $1`, [f.orgA.orgId])).toBe(1);
    for (const change of [`name = 'x'`, `inn = '1'`, `state = 'passive'`, `server_id = server_id, external_company_id = 'z'`])
      await expect(count(pools.auth, actor, `update hdu_organizations set ${change} where org_id = $1`, [f.orgA.orgId]), change).rejects.toThrow(/нельзя/);
  }
  for (const actor of [f.l1.actor, f.aAdmin.actor])
    expect(await count(pools.auth, actor, `update hdu_organizations set category = 'B' where org_id = $1`, [f.orgA.orgId])).toBe(0);
  expect(await count(pools.auth, system, `update hdu_organizations set name = 'Из Smartup' where org_id = $1`, [f.orgA.orgId])).toBe(1);
  await expect(count(pools.auth, f.care.actor, `insert into hdu_organizations (server_id, external_company_id, name) values ($1, '9', 'x')`, [f.server.serverId])).rejects.toThrow(/row-level security/);
});

test('список сотрудников ведёт только администратор портала', async () => {
  const f = await seedTwoOrgs();
  expect((await rows(pools.auth, f.adminStaff.actor, 'select user_id from hdu_staff')).length).toBeGreaterThanOrEqual(3);
  expect(await count(pools.auth, f.adminStaff.actor, `update hdu_staff set is_lead = true where user_id = $1`, [f.l1.userId])).toBe(1);
  for (const actor of [f.care.actor, f.l1.actor, f.aAdmin.actor]) expect(await rows(pools.auth, actor, 'select user_id from hdu_staff')).toEqual([]);
});

test('результаты проверки серверов видят и пишут только администратор и система', async () => {
  const f = await seedTwoOrgs();
  const insert = `insert into hdu_server_checks (server_id, is_ok, issues) values ($1, true, '{}')
    on conflict (server_id) do update set is_ok = excluded.is_ok`;
  expect(await count(pools.auth, f.adminStaff.actor, insert, [f.server.serverId])).toBe(1);
  expect(await count(pools.auth, system, insert, [f.server.serverId])).toBe(1);
  for (const actor of [f.care.actor, f.l1.actor, f.aAdmin.actor])
    await expect(count(pools.auth, actor, insert, [f.server.serverId])).rejects.toThrow(/row-level security/);
  expect(await rows(pools.app, f.adminStaff.actor, 'select is_ok from hdu_server_checks')).toEqual([{ is_ok: true }]);
  expect(await rows(pools.app, f.l1.actor, 'select is_ok from hdu_server_checks')).toEqual([{ is_ok: true }]);
  expect(await rows(pools.app, f.aAdmin.actor, 'select is_ok from hdu_server_checks')).toEqual([]);
  await expect(
    pools.root.query(`insert into hdu_server_checks (server_id, is_ok, issues) values ($1, false, '{made_up}') on conflict (server_id) do update set issues = excluded.issues`, [f.server.serverId]),
  ).rejects.toThrow(/hdu_server_checks_c/);
});

test('код сервера нельзя изменить, второй сервер по умолчанию нельзя завести', async () => {
  const f = await seedTwoOrgs();
  await expect(
    pools.root.query(`update hdu_servers set code = 'renamed' where server_id = $1`, [f.server.serverId]),
  ).rejects.toThrow(/нельзя/);
  const add = (code: string) =>
    pools.root.query(
      `insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, is_default, code)
       values ('x', $1, $1, 'c', $2, true, $3)`,
      [`https://${code}.example.test`, SEALED, code],
    );
  await add('default-one');
  await expect(add('default-two')).rejects.toThrow(/hdu_servers_u4/);
});

test('одна компания сервера это одна организация, роль и источник членства только из перечня', async () => {
  const f = await seedTwoOrgs();
  await expect(
    pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, '501', 'Двойник')`, [
      f.server.serverId,
    ]),
  ).rejects.toThrow(/hdu_organizations_u1/);
  await expect(
    pools.root.query(`update hdu_memberships set role = 'admin' where user_id = $1`, [f.aUser.userId]),
  ).rejects.toThrow(/hdu_memberships_c/);
  await expect(
    pools.root.query(`update hdu_staff set role = 'client_admin' where user_id = $1`, [f.l1.userId]),
  ).rejects.toThrow(/hdu_staff_c/);
});

test('токен подтверждения адреса клиент создаёт и видит только свой', async () => {
  const f = await seedTwoOrgs();
  const insert = (actor: Actor, userId: string) =>
    count(
      pools.auth,
      actor,
      `insert into hdu_email_tokens (user_id, email, token_hash, expires_on)
       values ($1, 'a@acme.test', encode(sha256(random()::text::bytea), 'hex'), now() + interval '1 hour')`,
      [userId],
    );
  expect(await insert(f.aUser.actor, f.aUser.userId)).toBe(1);
  await expect(insert(f.aUser.actor, f.aAdmin.userId)).rejects.toThrow(/row-level security/);
  expect(await rows(pools.auth, f.aUser.actor, 'select user_id from hdu_email_tokens')).toEqual([{ user_id: f.aUser.userId }]);
  expect(await rows(pools.auth, f.aAdmin.actor, 'select user_id from hdu_email_tokens')).toEqual([]);
  expect(await rows(pools.auth, f.care.actor, 'select user_id from hdu_email_tokens')).toEqual([]);
});

test('актор AI-сотрудника не видит таблицы идентичности', async () => {
  await seedTwoOrgs();
  const agent: AgentActor = { type: 'agent', tokenId: 't1', tools: [] };
  for (const sql of [
    'select * from hdu_organizations',
    'select * from hdu_memberships',
    'select * from hdu_user_profiles',
    'select invitation_id from hdu_invitations',
    'select code from hdu_servers',
  ])
    expect(await rows(pools.app, agent, sql), sql).toEqual([]);
});

test('служебные колонки таблиц идентичности заполняет база', async () => {
  const f = await seedTwoOrgs();
  await count(pools.auth, f.care.actor, `update hdu_memberships set role = 'client_admin', is_role_manual = true where user_id = $1`, [
    f.aUser.userId,
  ]);
  const r = await pools.root.query(`select modified_by, created_by from hdu_memberships where user_id = $1`, [f.aUser.userId]);
  expect(r.rows[0]).toEqual({ modified_by: f.care.userId, created_by: null });
});

test('удаление организации обнуляет ссылки на неё в сессии и у пользователя', async () => {
  const f = await seedTwoOrgs();
  const org = (
    await pools.root.query(
      `insert into hdu_organizations (server_id, external_company_id, name) values ($1, '999', 'Временная') returning org_id`,
      [f.server.serverId],
    )
  ).rows[0].org_id;
  await pools.root.query(`update auth."user" set "lastOrgId" = $1 where id = $2`, [org, f.aUser.userId]);
  await pools.root.query(
    `insert into auth.session ("expiresAt", token, "updatedAt", "userId", "activeOrgId") values (now() + interval '1 day', 'tok-org', now(), $1, $2)`,
    [f.aUser.userId, org],
  );
  await pools.root.query(`delete from hdu_organizations where org_id = $1`, [org]);
  expect((await pools.root.query(`select "lastOrgId" from auth."user" where id = $1`, [f.aUser.userId])).rows[0].lastOrgId).toBeNull();
  expect((await pools.root.query(`select "activeOrgId" from auth.session where token = 'tok-org'`)).rows[0].activeOrgId).toBeNull();
});

// --- Контакты и коды (задача 16) ---

test('клиент видит только свою привязку Telegram, коды не видит никто из клиентов', async () => {
  const f = await seedTwoOrgs();
  await linkTelegramFixture(f.aUser, 777001);
  await linkTelegramFixture(f.bUser, 777002);
  await pools.root.query(
    `insert into hdu_link_codes (user_id, kind, code_hash, expires_on) values ($1, 'telegram', encode(sha256('a'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdu_login_codes (user_id, channel, code_hash, expires_on) values ($1, 'telegram', encode(sha256('b'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(`insert into hdn_telegram_updates (update_id) values (1)`);
  expect(await rows(pools.app, f.aUser.actor, 'select external_id from hdu_contact_identities')).toEqual([{ external_id: '777001' }]);
  // Администратор клиента чужих привязок, в том числе своих участников, не видит.
  expect(await rows(pools.app, f.aAdmin.actor, 'select external_id from hdu_contact_identities')).toEqual([]);
  for (const table of ['hdu_link_codes', 'hdu_login_codes', 'hdn_telegram_updates']) {
    const found = await asActor(pools.app, f.aUser.actor, (c) => c.query(`select * from ${table}`)).then(
      (x) => x.rows,
      (e: unknown) => {
        expect(String(e)).toMatch(/permission denied/);
        return [];
      },
    );
    expect(found, table).toEqual([]);
  }
  // Клиент удаляет только свою привязку.
  expect((await asActor(pools.auth, f.aUser.actor, (c) => c.query(`delete from hdu_contact_identities where external_id = '777002'`))).rowCount).toBe(0);
  expect((await asActor(pools.auth, f.aUser.actor, (c) => c.query(`delete from hdu_contact_identities where external_id = '777001'`))).rowCount).toBe(1);
  // Сотрудники видят привязки, но не коды.
  expect((await rows(pools.app, f.care.actor, 'select external_id from hdu_contact_identities')).map((r) => r.external_id)).toEqual(['777002']);
  // Клиент не создаёт привязку сам: это делает система по коду из бота.
  await expect(
    asActor(pools.auth, f.aUser.actor, (c) =>
      c.query(`insert into hdu_contact_identities (user_id, kind, external_id, verified, verified_on) values ($1, 'telegram', '1', 'linked', now())`, [f.aUser.userId]),
    ),
  ).rejects.toThrow(/row-level security|permission denied/);
});

test('список сотрудников под ролью hub_auth меняет только admin', async () => {
  const f = await seedTwoOrgs();
  const block = (actor: Actor) =>
    asActor(pools.auth, actor, (c) => c.query(`update hdu_staff set state = 'passive' where user_id = $1`, [f.l1.userId])).then((x) => x.rowCount);
  expect(await block(f.care.actor)).toBe(0);
  expect(await block(f.aAdmin.actor)).toBe(0);
  expect(await block(f.adminStaff.actor)).toBe(1);
});

test('клиент, сотрудник и система с непросроченными строками удалить строки идентичности не могут', async () => {
  const f = await seedTwoOrgs();
  const user = f.aUser.userId;
  const hash = (n: number) => n.toString(16).padStart(64, 'a');
  for (const [i, age] of ["now() - interval '25 hours'", "now() - interval '23 hours'"].entries()) {
    await pools.root.query(`insert into hdu_email_tokens (user_id, email, token_hash, expires_on) values ($1, 'del@acme.test', $2, ${age})`, [user, hash(40 + i)]);
    await pools.root.query(`insert into hdu_link_codes (user_id, kind, code_hash, expires_on) values ($1, 'telegram', $2, ${age})`, [user, hash(50 + i)]);
    await pools.root.query(`insert into hdu_login_codes (user_id, channel, code_hash, expires_on) values ($1, 'telegram', $2, ${age})`, [user, hash(60 + i)]);
  }
  for (const table of ['hdu_email_tokens', 'hdu_link_codes', 'hdu_login_codes']) {
    // Клиент и сотрудник не удаляют ничего, даже свои просроченные строки.
    for (const actor of [f.aUser.actor, f.adminStaff.actor]) expect(await count(pools.auth, actor, `delete from ${table} where user_id = $1`, [user]), table).toBe(0);
    // Система удаляет только строки, срок которых вышел больше суток назад.
    expect(await count(pools.auth, system, `delete from ${table} where user_id = $1 and expires_on > now() - interval '1 day'`, [user]), table).toBe(0);
    expect(await count(pools.auth, system, `delete from ${table} where user_id = $1`, [user]), table).toBe(1);
    // Под ролью приложения таблицы закрыты.
    await expect(count(pools.app, system, `delete from ${table}`), table).rejects.toThrow(/permission denied/);
  }
});
