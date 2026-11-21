import { expect, test } from 'vitest';
import { acknowledgePolicy } from '@/modules/hdu/api/email';
import { listMyOrganizations, resolveClient, switchOrganization, type ClientContext } from '@/modules/hdu/api/orgs';
import { resolveStaff } from '@/modules/hdu/api/session';
import { needsPolicyNotice } from '@/modules/hdu/util';
import { addMembership, buildTestAuth, clientSession, enrolledStaffFixture, reload, verifiedClientFixture } from './helpers/auth';
import { isLoginLinkRecipient } from '@/modules/hdu/core/email';
import { createLoginCode } from '@/modules/hdu/core/telegram';
import { pools } from './helpers/db';
import { linkTelegramFixture } from './helpers/telegram';
import { seedTwoOrgs } from './isolation/fixture';

test('без сессии актор не строится', async () => {
  expect(await resolveClient(null)).toEqual({ denied: 'no_session' });
});

test('актор берёт организацию и роль из членства, а не из сессии', async () => {
  const f = await seedTwoOrgs();
  const session = await clientSession(f.aUser, { activeOrgId: f.orgB.orgId }); // подставленная чужая организация
  const ctx = await resolveClient(session);
  expect(ctx).toMatchObject({
    actor: { type: 'client', userId: f.aUser.userId, orgId: f.orgA.orgId, orgRole: 'client_user' },
    org: { id: f.orgA.orgId, name: f.orgA.name },
    orgCount: 1,
    user: { id: f.aUser.userId, name: f.aUser.name, hasVerifiedEmail: false, onboarded: false },
  });
  expect((await pools.root.query(`select "activeOrgId" from auth.session where id = $1`, [session.session.id])).rows[0].activeOrgId).toBe(
    f.orgA.orgId,
  );
});

test('роль администратора клиента видна актору', async () => {
  const f = await seedTwoOrgs();
  expect(await resolveClient(await clientSession(f.aAdmin))).toMatchObject({ actor: { orgRole: 'client_admin' } });
});

test('отключённое членство и отключённая организация закрывают доступ на следующем запросе', async () => {
  const f = await seedTwoOrgs();
  const session = await clientSession(f.aUser);
  expect(await resolveClient(session)).toMatchObject({ org: { id: f.orgA.orgId } });
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId]);
  expect(await resolveClient((await reload(session))!)).toEqual({ denied: 'no_organization' });
  await pools.root.query(`update hdu_memberships set state = 'active' where user_id = $1`, [f.aUser.userId]);
  await pools.root.query(`update hdu_organizations set state = 'passive' where org_id = $1`, [f.orgA.orgId]);
  expect(await resolveClient((await reload(session))!)).toEqual({ denied: 'no_organization' });
});

test('участник двух организаций без выбора попадает на выбор, после выбора актор следует за ним', async () => {
  const f = await seedTwoOrgs();
  await addMembership(f.aUser.userId, f.orgB.orgId);
  const session = await clientSession(f.aUser, { activeOrgId: null, lastOrgId: null });
  expect(await resolveClient(session)).toEqual({ denied: 'choose_organization' });
  await switchOrganization(session, f.orgB.orgId);
  expect(await resolveClient((await reload(session))!)).toMatchObject({ actor: { orgId: f.orgB.orgId }, orgCount: 2 });
  expect((await pools.root.query(`select "lastOrgId" from auth."user" where id = $1`, [f.aUser.userId])).rows[0].lastOrgId).toBe(f.orgB.orgId);
});

test('новая сессия начинается с организации последнего входа', async () => {
  const f = await seedTwoOrgs();
  await addMembership(f.aUser.userId, f.orgB.orgId);
  const session = await clientSession(f.aUser, { activeOrgId: null, lastOrgId: f.orgB.orgId });
  expect(await resolveClient(session)).toMatchObject({ actor: { orgId: f.orgB.orgId } });
  // Последняя организация отключена: остаётся выбор между действующими.
  await pools.root.query(`update hdu_organizations set state = 'passive' where org_id = $1`, [f.orgB.orgId]);
  const fresh = await clientSession(f.aUser, { activeOrgId: null });
  expect(await resolveClient(fresh)).toMatchObject({ actor: { orgId: f.orgA.orgId }, orgCount: 1 });
});

test('переключиться в организацию без членства нельзя', async () => {
  const f = await seedTwoOrgs();
  const session = await clientSession(f.aUser);
  await expect(switchOrganization(session, f.orgB.orgId)).rejects.toMatchObject({ code: 'not_member' });
  await expect(switchOrganization(session, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' });
  expect(await resolveClient((await reload(session))!)).toMatchObject({ actor: { orgId: f.orgA.orgId } });
});

test('сотрудник не получает актора клиента', async () => {
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'care' });
  expect(await resolveClient(await clientSession(staff))).toEqual({ denied: 'staff' });
});

test('клиент не получает актора сотрудника', async () => {
  const f = await seedTwoOrgs();
  expect(await resolveStaff(await clientSession(f.aAdmin), new Date())).toEqual({ denied: 'not_staff' });
});

test('подтверждённый адрес и пройденный первый вход видны актору', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'real@acme.test', "emailVerified" = true, "onboardedAt" = now() where id = $1`, [
    f.aUser.userId,
  ]);
  expect(((await resolveClient(await clientSession(f.aUser))) as ClientContext).user).toMatchObject({ hasVerifiedEmail: true, onboarded: true });
});

// --- Гости и политика обработки данных (задача 21) ---

test('гостевое членство не даёт войти и не показывается в списке организаций', async () => {
  const f = await seedTwoOrgs();
  const guest = await verifiedClientFixture('guest@example.test', { memberships: 0 });
  await addMembership(guest.userId, f.orgA.orgId, 'client_user', 'guest');
  expect(await resolveClient(await clientSession(guest))).toEqual({ denied: 'no_organization' });
  expect(await listMyOrganizations(guest.userId)).toEqual([]);
  // Гость и участник одновременно: видна только организация с обычным членством.
  await addMembership(guest.userId, f.orgB.orgId, 'client_user', 'invite');
  expect((await listMyOrganizations(guest.userId)).map((org) => org.orgId)).toEqual([f.orgB.orgId]);
  await expect(switchOrganization(await clientSession(guest), f.orgA.orgId)).rejects.toMatchObject({ code: 'not_member' });
});

test('версия политики записывается и запрашивается снова после новой версии', async () => {
  const f = await seedTwoOrgs();
  await acknowledgePolicy(f.aUser.userId, '2026-12-01');
  const version = async () => (await pools.root.query(`select "policyVersion" from auth."user" where id = $1`, [f.aUser.userId])).rows[0].policyVersion;
  expect(await version()).toBe('2026-12-01');
  await acknowledgePolicy(f.aUser.userId, '2027-03-01');
  expect(await version()).toBe('2027-03-01');
  await expect(acknowledgePolicy(f.aUser.userId, '../../x')).rejects.toMatchObject({ code: 'invalid_input' });
  expect(needsPolicyNotice({ policyVersion: '2026-12-01' }, '2026-12-01')).toBe(false);
  expect(needsPolicyNotice({ policyVersion: '2026-12-01' }, '2027-03-01')).toBe(true);
  expect(needsPolicyNotice({ policyVersion: null }, '2026-12-01')).toBe(true);
  // Политика выключена: показывать нечего.
  expect(needsPolicyNotice({ policyVersion: null }, null)).toBe(false);
  // История согласия: каждая новая редакция отдельной записью журнала, повтор той же записи не даёт (проверка main, Q17).
  await acknowledgePolicy(f.aUser.userId, '2027-03-01');
  const history = (
    await pools.root.query(`select object_id, diff from hdc_audit_log where action = 'user.policy_acknowledged' order by created_on, audit_id`)
  ).rows;
  expect(history).toEqual([
    { object_id: f.aUser.userId, diff: { version: '2026-12-01' } },
    { object_id: f.aUser.userId, diff: { version: '2027-03-01' } },
  ]);
});

test('отключённый сервер Smartup закрывает вход его клиентам всеми путями (проверка main, S4)', async () => {
  const f = await seedTwoOrgs();
  const ctxBefore = await resolveClient(await clientSession(f.aUser));
  expect(ctxBefore).toHaveProperty('actor');
  await pools.root.query(`update auth."user" set email = 'a-user@acme.test', "emailVerified" = true where id = $1`, [f.aUser.userId]);
  await pools.root.query(`update hdu_servers set state = 'passive' where server_id = $1`, [f.server.serverId]);
  expect(await resolveClient(await clientSession(f.aUser))).toEqual({ denied: 'no_organization' });
  expect(await listMyOrganizations(f.aUser.userId)).toEqual([]);
  expect(await isLoginLinkRecipient('a-user@acme.test')).toBe(false);
  await linkTelegramFixture(f.aUser, 777123);
  expect(await createLoginCode('777123')).toBeNull();
});
