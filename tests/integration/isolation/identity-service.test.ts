import { expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { inviteMember, listInvitations, revokeInvitation } from '@/modules/hdu/api/invitations';
import { listMembers, setMemberState } from '@/modules/hdu/api/members';
import { listMyOrganizations, resolveClient, type ClientContext } from '@/modules/hdu/api/orgs';
import { organizations } from '@/modules/hdu/schema';
import { clientCtx, clientSession, staffCtx } from '../helpers/auth';
import { pools } from '../helpers/db';
import { memoryMailerPerTest } from '../helpers/mail';
import { seedTwoOrgs } from './fixture';

// Проверки изоляции на уровне сервисов (ТЗ 15.2): те же правила, что в identity-direct, через функции модуля.

memoryMailerPerTest();

test('список организаций пользователя не содержит чужих и отключённых', async () => {
  const f = await seedTwoOrgs();
  expect(await listMyOrganizations(f.aUser.userId)).toEqual([{ orgId: f.orgA.orgId, name: f.orgA.name, role: 'client_user' }]);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId]);
  expect(await listMyOrganizations(f.aUser.userId)).toEqual([]);
});

test('актор клиента читает через withActor только свою организацию', async () => {
  const f = await seedTwoOrgs();
  const ctx = (await resolveClient(await clientSession(f.aUser))) as ClientContext;
  expect((await withActor(ctx.actor, (tx) => tx.select().from(organizations))).map((o) => o.orgId)).toEqual([f.orgA.orgId]);
});

test('приглашение с подставленной чужой организацией создаётся в своей', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, {
    email: 'forged@acme.test',
    role: 'client_user',
    locale: 'ru',
    orgId: f.orgB.orgId,
    org_id: f.orgB.orgId,
  });
  expect((await pools.root.query(`select org_id from hdu_invitations where email = 'forged@acme.test'`)).rows).toEqual([{ org_id: f.orgA.orgId }]);
});

test('администратор А не видит и не отзывает приглашения Б', async () => {
  const f = await seedTwoOrgs();
  const { invitationId } = await inviteMember({ ctx: await clientCtx(f.bAdmin) }, { email: 'b-only@globex.test', role: 'client_user', locale: 'ru' });
  const ctxA = await clientCtx(f.aAdmin);
  expect((await listInvitations({ ctx: ctxA })).map((i) => i.email)).not.toContain('b-only@globex.test');
  await expect(revokeInvitation({ ctx: ctxA }, invitationId)).rejects.toMatchObject({ code: 'not_found' });
  expect((await pools.root.query(`select revoked_on from hdu_invitations where invitation_id = $1`, [invitationId])).rows[0].revoked_on).toBeNull();
});

test('список участников содержит только свою организацию и не содержит email', async () => {
  const f = await seedTwoOrgs();
  const members = await listMembers({ ctx: await clientCtx(f.aAdmin) });
  expect(members.map((m) => m.userId).sort()).toEqual([f.aUser.userId, f.aAdmin.userId].sort());
  expect(Object.keys(members[0] ?? {})).not.toContain('email');
  expect(members.find((m) => m.userId === f.aAdmin.userId)).toMatchObject({ name: f.aAdmin.name, role: 'client_admin', isSelf: true });
});

test('обычный участник списки организации не читает', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  await expect(listMembers({ ctx })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(listInvitations({ ctx })).rejects.toMatchObject({ code: 'forbidden' });
});

test('сотрудник первой линии участников не отключает, Customer Care отключает в любой организации', async () => {
  const f = await seedTwoOrgs();
  await expect(setMemberState({ ctx: staffCtx(f.l1), orgId: f.orgB.orgId }, { userId: f.bUser.userId, state: 'passive' })).rejects.toMatchObject({
    code: 'forbidden',
  });
  await setMemberState({ ctx: staffCtx(f.care), orgId: f.orgB.orgId }, { userId: f.bUser.userId, state: 'passive' });
  expect((await listMembers({ ctx: staffCtx(f.care), orgId: f.orgB.orgId })).find((m) => m.userId === f.bUser.userId)?.state).toBe('passive');
  // Организация в области действия и пользователь из другой организации: не найдено.
  await expect(setMemberState({ ctx: staffCtx(f.care), orgId: f.orgB.orgId }, { userId: f.aUser.userId, state: 'passive' })).rejects.toMatchObject({
    code: 'not_found',
  });
});
