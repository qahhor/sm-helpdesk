import { expect, test } from 'vitest';
import { resolveClient, switchOrganization, type ClientContext } from '@/modules/hdu/api/orgs';
import { resolveStaff } from '@/modules/hdu/api/session';
import { addMembership, buildTestAuth, clientSession, enrolledStaffFixture, reload } from './helpers/auth';
import { pools } from './helpers/db';
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
