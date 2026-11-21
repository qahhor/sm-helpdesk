import { expect, test } from 'vitest';
import { acceptInvitation, describeInvitation, inviteMember, listInvitations, revokeInvitation } from '@/modules/hdu/api/invitations';
import { listMyOrganizations } from '@/modules/hdu/api/orgs';
import { hashToken } from '@/modules/hdu/tokens';
import { completeLoginLink, requestLoginLink } from '@/modules/hdu/api/login-link';
import { buildTestAuth, clientCtx, enrolledStaffFixture, newJar, noRequest, staffCtx, verifiedClientFixture } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest, tokenFrom } from './helpers/mail';
import { seedTwoOrgs } from './isolation/fixture';

// Приглашения в организацию клиента (FR-ID-08, FR-ID-13).

const box = memoryMailerPerTest();

/** Браузер, где клиент вошёл по ссылке на свой подтверждённый адрес. */
async function signedInAs(email: string) {
  const jar = newJar();
  const before = box.mailer.sent.length;
  await requestLoginLink({ email, locale: 'ru' }, noRequest);
  expect(await completeLoginLink({ token: tokenFrom(box.mailer.sent[before]), locale: 'ru' }, jar.request)).toMatchObject({ ok: true });
  box.mailer.sent.splice(before);
  return jar;
}

test('администратор клиента приглашает в свою организацию на 7 дней, токен в базе хешем', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'New@Acme.Test', role: 'client_user', locale: 'ru' });
  const row = (
    await pools.root.query(`select org_id, role, invited_by, token_hash, expires_on - now() as ttl from hdu_invitations where email = 'new@acme.test'`)
  ).rows[0];
  expect(row.org_id).toBe(f.orgA.orgId);
  expect(row.invited_by).toBe(f.aAdmin.userId);
  expect(row.ttl.days).toBe(6);
  expect(box.mailer.sent[0]).toMatchObject({ to: 'new@acme.test', kind: 'invitation' });
  expect(box.mailer.sent[0]?.text).toContain('Дильноза'); // имя в тексте, не в теме (проверка main, S8)
  expect(box.mailer.sent[0]?.text).toContain('ACME Trade');
  expect(box.mailer.sent[0]?.text).toMatch(/http:\/\/localhost:3000\/ru\/invite\?token=[\w-]{43}/);
  expect(row.token_hash).toBe(hashToken(tokenFrom(box.mailer.sent[0])));
});

test('обычный пользователь и первая линия приглашать не могут, Customer Care может', async () => {
  const f = await seedTwoOrgs();
  const input = { email: 'x@acme.test', role: 'client_user', locale: 'ru' };
  await expect(inviteMember({ ctx: await clientCtx(f.aUser) }, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(inviteMember({ ctx: staffCtx(f.l1), orgId: f.orgA.orgId }, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(inviteMember({ ctx: staffCtx(f.care), orgId: f.orgA.orgId }, { ...input, role: 'client_admin' })).resolves.toBeDefined();
  await expect(inviteMember({ ctx: staffCtx(f.care), orgId: 'not-a-uuid' }, input)).rejects.toMatchObject({ code: 'invalid_input' });
});

test('роль сотрудника и неверный адрес в приглашении клиента отклоняются', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  await expect(inviteMember({ ctx }, { email: 'x@acme.test', role: 'admin', locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(inviteMember({ ctx }, { email: 'not-an-email', role: 'client_user', locale: 'ru' })).rejects.toMatchObject({ code: 'invalid_input' });
  expect(box.mailer.sent).toEqual([]);
});

test('принятие создаёт пользователя с подтверждённым адресом, членство и сессию', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'new@acme.test', role: 'client_admin', locale: 'ru' });
  const token = tokenFrom(box.mailer.sent[0]);
  expect(await describeInvitation(token)).toEqual({ orgName: f.orgA.name, email: 'new@acme.test', needsName: true });
  expect(await acceptInvitation({ token, name: 'Новый Участник' }, noRequest)).toEqual({ ok: true });
  const user = (await pools.root.query(`select id, name, "emailVerified", "lastOrgId" from auth."user" where email = 'new@acme.test'`)).rows[0];
  expect(user).toMatchObject({ name: 'Новый Участник', emailVerified: true, lastOrgId: f.orgA.orgId });
  expect((await pools.root.query(`select org_id, role, source from hdu_memberships where user_id = $1`, [user.id])).rows).toEqual([
    { org_id: f.orgA.orgId, role: 'client_admin', source: 'invite' },
  ]);
  expect((await pools.root.query(`select 1 from auth.session where "userId" = $1`, [user.id])).rowCount).toBe(1);
  expect(await acceptInvitation({ token, name: 'x' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect(await describeInvitation(token)).toBeNull();
});

test('приглашение от сотрудника даёт членство с источником staff', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: staffCtx(f.care), orgId: f.orgB.orgId }, { email: 'boss@globex.test', role: 'client_admin', locale: 'uz' });
  expect(box.mailer.sent[0]?.text).toContain('http://localhost:3000/uz/invite?token=');
  await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]), name: 'Начальник' }, noRequest);
  expect((await pools.root.query(`select m.source, m.role from hdu_memberships m join auth."user" u on u.id = m.user_id where u.email = 'boss@globex.test'`)).rows).toEqual([
    { source: 'staff', role: 'client_admin' },
  ]);
});

test('существующий пользователь получает второе членство без второй учётной записи', async () => {
  const f = await seedTwoOrgs();
  const existing = await verifiedClientFixture('multi@acme.test', { orgId: f.orgA.orgId });
  await inviteMember({ ctx: await clientCtx(f.bAdmin) }, { email: 'multi@acme.test', role: 'client_user', locale: 'ru' });
  expect(await describeInvitation(tokenFrom(box.mailer.sent[0]))).toMatchObject({ needsName: false });
  const token = tokenFrom(box.mailer.sent[0]);
  expect(await acceptInvitation({ token }, (await signedInAs('multi@acme.test')).request)).toEqual({ ok: true });
  expect((await pools.root.query(`select count(*)::int as n from auth."user" where email = 'multi@acme.test'`)).rows[0].n).toBe(1);
  expect((await listMyOrganizations(existing.userId)).map((o) => o.orgId).sort()).toEqual([f.orgA.orgId, f.orgB.orgId].sort());
});

test('отключённое членство приглашение не включает', async () => {
  const f = await seedTwoOrgs();
  const existing = await verifiedClientFixture('gone@acme.test', { orgId: f.orgA.orgId });
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'other@acme.test', role: 'client_user', locale: 'ru' });
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [existing.userId]);
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'gone@acme.test', role: 'client_admin', locale: 'ru' });
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[1]) }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect((await pools.root.query(`select state, role from hdu_memberships where user_id = $1`, [existing.userId])).rows).toEqual([
    { state: 'passive', role: 'client_user' },
  ]);
});

test('отозванная и просроченная ссылка не принимаются, ответ одинаков', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  const { invitationId } = await inviteMember({ ctx }, { email: 'r@acme.test', role: 'client_user', locale: 'ru' });
  await revokeInvitation({ ctx }, invitationId);
  await inviteMember({ ctx }, { email: 'e@acme.test', role: 'client_user', locale: 'ru' });
  await pools.root.query(`update hdu_invitations set expires_on = now() - interval '1 minute' where email = 'e@acme.test'`);
  for (const mail of box.mailer.sent) expect(await acceptInvitation({ token: tokenFrom(mail), name: 'x' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  expect(await describeInvitation('x'.repeat(43))).toBeNull();
  for (const token of ['', null, 'short', '../../etc']) {
    expect(await describeInvitation(token)).toBeNull();
    expect(await acceptInvitation({ token }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
  }
});

test('адрес сотрудника не становится участником организации', async () => {
  const f = await seedTwoOrgs();
  const { auth } = await buildTestAuth();
  const staff = await enrolledStaffFixture(auth, { role: 'agent_l1' });
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: staff.email, role: 'client_admin', locale: 'ru' });
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]) }, noRequest)).toEqual({ ok: false, code: 'email_taken' });
  expect((await pools.root.query(`select 1 from hdu_memberships where user_id = $1`, [staff.userId])).rowCount).toBe(0);
});

test('действующего участника пригласить нельзя, повторное приглашение отменяет прежнее', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  await verifiedClientFixture('member@acme.test', { orgId: f.orgA.orgId });
  await expect(inviteMember({ ctx }, { email: 'member@acme.test', role: 'client_user', locale: 'ru' })).rejects.toMatchObject({ code: 'already_member' });
  await inviteMember({ ctx }, { email: 'twice@acme.test', role: 'client_user', locale: 'ru' });
  await inviteMember({ ctx }, { email: 'twice@acme.test', role: 'client_user', locale: 'ru' });
  expect(
    (await listInvitations({ ctx }))
      .filter((i) => i.email === 'twice@acme.test')
      .map((i) => i.status)
      .sort(),
  ).toEqual(['pending', 'revoked']);
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]), name: 'x' }, noRequest)).toEqual({ ok: false, code: 'link_invalid' });
});

test('список приглашений ограничен сотней новых (проверка main, Q13)', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(
    `insert into hdu_invitations (org_id, email, role, token_hash, invited_by, expires_on)
     select $1, 'bulk' || n || '@acme.test', 'client_user', encode(sha256(('bulk' || n)::bytea), 'hex'), $2, now() + interval '7 days'
     from generate_series(1, 120) n`,
    [f.orgA.orgId, f.aAdmin.userId],
  );
  const list = await listInvitations({ ctx: await clientCtx(f.aAdmin) });
  expect(list).toHaveLength(100);
  // Новые первыми: последние сто массовых, а ранние и приглашение из набора не попали.
  expect(list[0]?.email).toBe('bulk120@acme.test');
  expect(list.some((i) => i.email === 'bulk20@acme.test' || i.email === 'invited-a@acme.test')).toBe(false);
});

test('двадцать первое приглашение в организацию за час отклоняется', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  for (let i = 0; i < 20; i++) await inviteMember({ ctx }, { email: `p${i}@acme.test`, role: 'client_user', locale: 'ru' });
  await expect(inviteMember({ ctx }, { email: 'p21@acme.test', role: 'client_user', locale: 'ru' })).rejects.toMatchObject({ code: 'rate_limited' });
});

test('создание, отзыв и принятие записаны в журнал вместе с действием', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  const { invitationId } = await inviteMember({ ctx }, { email: 'log@acme.test', role: 'client_user', locale: 'ru' });
  await revokeInvitation({ ctx }, invitationId);
  expect((await pools.root.query(`select action, actor_id, org_id from hdc_audit_log where object_id = $1 order by audit_id`, [invitationId])).rows).toEqual([
    { action: 'invitation.created', actor_id: f.aAdmin.userId, org_id: f.orgA.orgId },
    { action: 'invitation.revoked', actor_id: f.aAdmin.userId, org_id: f.orgA.orgId },
  ]);
  const second = await inviteMember({ ctx }, { email: 'log2@acme.test', role: 'client_user', locale: 'ru' });
  await acceptInvitation({ token: tokenFrom(box.mailer.sent[1]), name: 'Журнал' }, noRequest);
  expect((await pools.root.query(`select action from hdc_audit_log where org_id = $1 and action in ('invitation.accepted', 'member.joined') order by audit_id`, [f.orgA.orgId])).rows.map((r) => r.action)).toEqual([
    'invitation.accepted',
    'member.joined',
  ]);
  expect(JSON.stringify((await pools.root.query(`select diff from hdc_audit_log where object_id = $1`, [second.invitationId])).rows)).not.toContain('log2@acme.test');
});

test('отозвать можно только ждущее приглашение', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aAdmin);
  const { invitationId } = await inviteMember({ ctx }, { email: 'once@acme.test', role: 'client_user', locale: 'ru' });
  await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]), name: 'Однажды' }, noRequest);
  await expect(revokeInvitation({ ctx }, invitationId)).rejects.toMatchObject({ code: 'not_found' });
  await expect(revokeInvitation({ ctx }, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' });
});

test('приглашение на существующую учётную запись принимается только после её входа: ссылка не служит входом на 7 дней (проверка main, S3)', async () => {
  const f = await seedTwoOrgs();
  const existing = await verifiedClientFixture('known@acme.test', { orgId: f.orgA.orgId });
  await verifiedClientFixture('stranger@acme.test', { orgId: f.orgA.orgId });
  await inviteMember({ ctx: await clientCtx(f.bAdmin) }, { email: 'known@acme.test', role: 'client_admin', locale: 'ru' });
  const token = tokenFrom(box.mailer.sent[0]);
  const sessions = async () => (await pools.root.query(`select count(*)::int as n from auth.session where "userId" = $1`, [existing.userId])).rows[0].n;
  // Без входа: просьба войти, приглашение ждёт, членства нет, сессии не появилось.
  expect(await acceptInvitation({ token }, noRequest)).toEqual({ ok: false, code: 'sign_in_required' });
  // В чужой учётной записи отдельный ответ: страница предложит выйти, а не войти (итоговая проверка, замечание 2).
  expect(await acceptInvitation({ token }, (await signedInAs('stranger@acme.test')).request)).toEqual({ ok: false, code: 'wrong_account' });
  expect(await sessions()).toBe(0);
  expect((await pools.root.query(`select accepted_on from hdu_invitations where email = 'known@acme.test'`)).rows[0].accepted_on).toBeNull();
  // Вошедший владелец адреса принимает: новая сессия не создаётся, организация становится активной.
  const jar = await signedInAs('known@acme.test');
  expect(await sessions()).toBe(1);
  expect(await acceptInvitation({ token }, jar.request)).toEqual({ ok: true });
  expect(await sessions()).toBe(1);
  expect((await listMyOrganizations(existing.userId)).map((o) => o.orgId).sort()).toEqual([f.orgA.orgId, f.orgB.orgId].sort());
  expect((await pools.root.query(`select "activeOrgId" from auth.session where "userId" = $1`, [existing.userId])).rows[0].activeOrgId).toBe(f.orgB.orgId);
});

test('гость, которого пригласили, становится обычным участником (отложенное замечание M1)', async () => {
  const f = await seedTwoOrgs();
  const guest = await verifiedClientFixture('guest-invite@acme.test', { orgId: f.orgA.orgId });
  await pools.root.query(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_user', 'guest')`, [f.orgB.orgId, guest.userId]);
  await inviteMember({ ctx: await clientCtx(f.bAdmin) }, { email: 'guest-invite@acme.test', role: 'client_admin', locale: 'ru' });
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]) }, (await signedInAs('guest-invite@acme.test')).request)).toEqual({ ok: true });
  expect((await pools.root.query(`select source, role from hdu_memberships where org_id = $1 and user_id = $2`, [f.orgB.orgId, guest.userId])).rows).toEqual([
    { source: 'invite', role: 'client_admin' },
  ]);
});

test('учётная запись, которой войти нечем, принимает приглашение по ссылке и получает сессию (итоговая проверка, замечание 1)', async () => {
  const f = await seedTwoOrgs();
  // Гость без другого членства и человек, чьё единственное членство отключено: войти в портал им нечем.
  const guest = await verifiedClientFixture('only-guest@acme.test', { memberships: 0 });
  await pools.root.query(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, 'client_user', 'guest')`, [f.orgB.orgId, guest.userId]);
  const blocked = await verifiedClientFixture('blocked@acme.test', { orgId: f.orgA.orgId });
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [blocked.userId]);
  for (const [email, userId] of [
    ['only-guest@acme.test', guest.userId],
    ['blocked@acme.test', blocked.userId],
  ] as const) {
    const before = box.mailer.sent.length;
    await inviteMember({ ctx: await clientCtx(f.bAdmin) }, { email, role: 'client_user', locale: 'ru' });
    const jar = newJar();
    expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[before]) }, jar.request), email).toEqual({ ok: true });
    expect((await pools.root.query(`select count(*)::int as n from auth.session where "userId" = $1`, [userId])).rows[0].n, email).toBe(1);
    expect((await listMyOrganizations(userId)).map((o) => o.orgId), email).toEqual([f.orgB.orgId]);
  }
  // Отключённое членство в организации A осталось отключённым.
  expect((await pools.root.query(`select state from hdu_memberships where user_id = $1 and org_id = $2`, [blocked.userId, f.orgA.orgId])).rows[0].state).toBe('passive');
});

test('принятие приглашения пишется в журнал с адресом запроса (итоговая проверка доработки, замечание 8)', async () => {
  const f = await seedTwoOrgs();
  await inviteMember({ ctx: await clientCtx(f.aAdmin) }, { email: 'with-ip@acme.test', role: 'client_user', locale: 'ru' });
  expect(await acceptInvitation({ token: tokenFrom(box.mailer.sent[0]), name: 'Айбек' }, newJar({ 'x-forwarded-for': '203.0.113.74' }).request)).toEqual({ ok: true });
  const rows = (await pools.root.query(`select action, host(ip) as ip from hdc_audit_log where action in ('invitation.accepted', 'member.joined') order by action`)).rows;
  expect(rows).toEqual([
    { action: 'invitation.accepted', ip: '203.0.113.74' },
    { action: 'member.joined', ip: '203.0.113.74' },
  ]);
});
