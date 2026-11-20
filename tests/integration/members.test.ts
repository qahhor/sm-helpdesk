import { expect, test } from 'vitest';
import { changeMemberRole, listMembersForStaff, setMemberState } from '@/modules/hdu/api/members';
import { getOrganization, resolveClient, searchOrganizations } from '@/modules/hdu/api/orgs';
import { clientCtx, clientSession, reload, staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Отключение участника (пункт 12 таблицы решений плана M1, решение 0014, раздел 8).

test('администратор клиента отключает участника своей организации, но не себя и не чужого', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  const victim = await clientSession(f.aUser);
  await setMemberState({ ctx }, { userId: f.aUser.userId, state: 'passive' });
  // Сессия не удаляется: доступ закрывает проверка членства на следующем запросе.
  expect(await reload(victim)).not.toBeNull();
  expect(await resolveClient((await reload(victim))!)).toEqual({ denied: 'no_organization' });
  await expect(setMemberState({ ctx }, { userId: f.aAdmin.userId, state: 'passive' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(setMemberState({ ctx }, { userId: f.bUser.userId, state: 'passive' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(setMemberState({ ctx: await clientCtx(f.bUser) }, { userId: f.bAdmin.userId, state: 'passive' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(setMemberState({ ctx }, { userId: f.aUser.userId, state: 'deleted' })).rejects.toMatchObject({ code: 'invalid_input' });
  const audit = (await pools.root.query(`select actor_id, org_id, object_id, diff from hdc_audit_log where action = 'member.state_changed'`)).rows;
  expect(audit).toEqual([{ actor_id: f.aAdmin.userId, org_id: f.orgA.orgId, object_id: f.aUser.userId, diff: { from: 'active', to: 'passive' } }]);
});

test('включённый снова участник возвращается в кабинет, повтор того же состояния журнал не пишет', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  await setMemberState({ ctx }, { userId: f.aUser.userId, state: 'passive' });
  await setMemberState({ ctx }, { userId: f.aUser.userId, state: 'passive' });
  await setMemberState({ ctx }, { userId: f.aUser.userId, state: 'active' });
  expect(await resolveClient(await clientSession(f.aUser))).toMatchObject({ org: { id: f.orgA.orgId } });
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'member.state_changed'`)).rows[0].n).toBe(2);
});

test('роль участника этим действием не меняется', async () => {
  const f = await seedTwoOrgs();
  await setMemberState({ ctx: await clientCtx(f.aAdmin) }, { userId: f.aUser.userId, state: 'passive', role: 'client_admin' });
  expect((await pools.root.query(`select role from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows[0].role).toBe('client_user');
});

// --- Роль участника и организации в рабочем месте (задача 12, FR-ID-13, FR-ADM-02) ---

test('care назначает администратора клиента, роль отмечена как выданная вручную', async () => {
  const f = await seedTwoOrgs();
  await changeMemberRole(staffCtx(f.care), { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' });
  expect((await pools.root.query(`select role, is_role_manual from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows).toEqual([
    { role: 'client_admin', is_role_manual: true },
  ]);
  expect((await pools.root.query(`select actor_id, org_id, object_id, diff from hdc_audit_log where action = 'member.role_changed'`)).rows).toEqual([
    { actor_id: f.care.userId, org_id: f.orgA.orgId, object_id: f.aUser.userId, diff: { from: 'client_user', to: 'client_admin' } },
  ]);
});

test('первая и вторая линия, product и AI-сотрудник роль не меняют', async () => {
  const f = await seedTwoOrgs();
  for (const role of ['agent_l1', 'agent_l2', 'product', 'agent_bot'] as const)
    await expect(
      changeMemberRole(staffCtx(await staffWithRole(role)), { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  expect((await pools.root.query(`select role from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows[0].role).toBe('client_user');
});

test('смена роли требует свежего входа', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.care);
  const later = new Date(ctx.sessionCreatedAt.getTime() + 901_000);
  await expect(changeMemberRole(ctx, { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' }, later)).rejects.toMatchObject({
    code: 'stale_session',
  });
});

test('если запись журнала не прошла, роль не меняется', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`alter table hdc_audit_log add constraint test_block check (action <> 'member.role_changed')`);
  try {
    await expect(changeMemberRole(staffCtx(f.care), { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' })).rejects.toThrow();
    expect((await pools.root.query(`select role from hdu_memberships where user_id = $1`, [f.aUser.userId])).rows[0].role).toBe('client_user');
  } finally {
    await pools.root.query('alter table hdc_audit_log drop constraint test_block');
  }
});

test('участника чужой организации под видом своей не изменить, неверный вход отклоняется', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.care);
  await expect(changeMemberRole(ctx, { orgId: f.orgA.orgId, userId: f.bUser.userId, role: 'client_admin' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(changeMemberRole(ctx, { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'admin' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(changeMemberRole(ctx, { orgId: 'x', userId: f.aUser.userId, role: 'client_admin' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('вход через Smartup роль, выданную вручную, не понижает', async () => {
  const f = await seedTwoOrgs();
  await changeMemberRole(staffCtx(f.care), { orgId: f.orgA.orgId, userId: f.aUser.userId, role: 'client_admin' });
  expect(await resolveClient(await clientSession(f.aUser))).toMatchObject({ actor: { orgRole: 'client_admin' } });
});

test('поиск организаций находит по названию, ИНН и идентификатору компании, знаки шаблона не работают как шаблон', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update hdu_organizations set inn = '305123456' where org_id = $1`, [f.orgB.orgId]);
  const ctx = staffCtx(f.l1);
  expect((await searchOrganizations(ctx, { query: f.orgA.name.slice(0, 4).toUpperCase() })).items.map((o) => o.orgId)).toContain(f.orgA.orgId);
  expect((await searchOrganizations(ctx, { query: '305123' })).items.map((o) => o.orgId)).toEqual([f.orgB.orgId]);
  expect((await searchOrganizations(ctx, { query: '502' })).items.map((o) => o.orgId)).toEqual([f.orgB.orgId]);
  for (const query of ['%', '_', '\\']) expect((await searchOrganizations(ctx, { query })).items).toEqual([]);
  const all = await searchOrganizations(ctx, {});
  expect(all.items.length).toBeGreaterThanOrEqual(2);
  expect(all.items.find((o) => o.orgId === f.orgA.orgId)).toMatchObject({ name: 'ACME Trade', serverName: 'Облако', state: 'active', memberCount: 2 });
  await expect(searchOrganizations(ctx, { query: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(searchOrganizations(ctx, { page: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('поиск отдаёт по 50 организаций и говорит, есть ли ещё', async () => {
  const f = await seedTwoOrgs();
  for (let i = 0; i < 55; i++)
    await pools.root.query(`insert into hdu_organizations (server_id, external_company_id, name) values ($1, $2, $3)`, [f.server.serverId, `p${i}`, `Пачка ${String(i).padStart(2, '0')}`]);
  const ctx = staffCtx(f.l1);
  const first = await searchOrganizations(ctx, { query: 'Пачка' });
  expect(first.items).toHaveLength(50);
  expect(first.hasMore).toBe(true);
  const second = await searchOrganizations(ctx, { query: 'Пачка', page: 2 });
  expect(second.items).toHaveLength(5);
  expect(second.hasMore).toBe(false);
});

test('карточка организации: несуществующая и неверная дают пусто', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.l1);
  expect(await getOrganization(ctx, f.orgA.orgId)).toMatchObject({ orgId: f.orgA.orgId, name: 'ACME Trade', memberCount: 2 });
  expect(await getOrganization(ctx, '01900000-0000-7000-8000-000000000000')).toBeNull();
  expect(await getOrganization(ctx, 'not-a-uuid')).toBeNull();
});

test('сотрудник видит подтверждённый адрес участника, служебный адрес не показывается', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'real@acme.test', "emailVerified" = true where id = $1`, [f.aAdmin.userId]);
  const members = await listMembersForStaff(staffCtx(f.l1), f.orgA.orgId);
  expect(members.find((m) => m.userId === f.aAdmin.userId)?.email).toBe('real@acme.test');
  expect(members.find((m) => m.userId === f.aUser.userId)?.email).toBeNull();
  expect(members.find((m) => m.userId === f.aUser.userId)?.isSelf).toBe(false);
});

test('AI-сотрудник организации и участников не видит', async () => {
  const f = await seedTwoOrgs();
  const bot = staffCtx(await staffWithRole('agent_bot'));
  await expect(searchOrganizations(bot, {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(getOrganization(bot, f.orgA.orgId)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(listMembersForStaff(bot, f.orgA.orgId)).rejects.toMatchObject({ code: 'forbidden' });
});
