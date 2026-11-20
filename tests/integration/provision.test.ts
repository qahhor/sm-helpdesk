import { expect, test } from 'vitest';
import { provisionFromSmartup } from '@/modules/hdu/core/provision';
import { newSmartupUser } from './helpers/auth';
import { pools } from './helpers/db';

const profile = { id: '1001', name: 'Алишер', companyId: '501', companyName: 'ACME Trade' };
const membershipsOf = async (userId: string) =>
  (await pools.root.query(`select org_id, role, source, state, is_role_manual from hdu_memberships where user_id = $1 order by created_on`, [userId])).rows;

test('первый вход создаёт организацию и членство, повторный не создаёт дублей и обновляет название', async () => {
  const { server, user } = await newSmartupUser();
  const first = await provisionFromSmartup(user.id, server.code, profile);
  const second = await provisionFromSmartup(user.id, server.code, { ...profile, companyName: 'ACME Trade LLC', inn: '301234567' });
  expect(second).toEqual(first);
  const { orgId } = first as { orgId: string };
  expect((await pools.root.query(`select name, inn, server_id from hdu_organizations where org_id = $1`, [orgId])).rows).toEqual([
    { name: 'ACME Trade LLC', inn: '301234567', server_id: server.serverId },
  ]);
  expect(await membershipsOf(user.id)).toEqual([{ org_id: orgId, role: 'client_user', source: 'smartup', state: 'active', is_role_manual: false }]);
});

test('пустой ИНН не стирает уже известный', async () => {
  const { server, user } = await newSmartupUser();
  const { orgId } = (await provisionFromSmartup(user.id, server.code, { ...profile, inn: '301234567' })) as { orgId: string };
  await provisionFromSmartup(user.id, server.code, { ...profile, inn: '' });
  expect((await pools.root.query(`select inn from hdu_organizations where org_id = $1`, [orgId])).rows[0].inn).toBe('301234567');
});

test('вход с другой компанией добавляет второе членство и делает её последней организацией', async () => {
  const { server, user } = await newSmartupUser();
  await provisionFromSmartup(user.id, server.code, profile);
  const other = (await provisionFromSmartup(user.id, server.code, { ...profile, companyId: '777', companyName: 'Второй филиал' })) as { orgId: string };
  expect(await membershipsOf(user.id)).toHaveLength(2);
  expect((await pools.root.query(`select "lastOrgId" from auth."user" where id = $1`, [user.id])).rows[0].lastOrgId).toBe(other.orgId);
});

test('роль из соответствия ролей сервера даёт администратора, роль, выданная вручную, не меняется', async () => {
  const { server, user } = await newSmartupUser({ roleMap: { director: 'client_admin' } });
  const role = async () => (await membershipsOf(user.id))[0]?.role;
  await provisionFromSmartup(user.id, server.code, { ...profile, role: 'director' });
  expect(await role()).toBe('client_admin');
  await provisionFromSmartup(user.id, server.code, { ...profile, role: 'cashier' });
  expect(await role()).toBe('client_user');
  expect((await pools.root.query(`select diff from hdc_audit_log where action = 'member.role_changed'`)).rows).toEqual([
    { diff: { from: 'client_admin', to: 'client_user', source: 'smartup' } },
  ]);
  await pools.root.query(`update hdu_memberships set role = 'client_admin', is_role_manual = true where user_id = $1`, [user.id]);
  await provisionFromSmartup(user.id, server.code, { ...profile, role: 'cashier' });
  expect(await role()).toBe('client_admin');
});

test('отключённое членство вход не включает', async () => {
  const { server, user } = await newSmartupUser();
  await provisionFromSmartup(user.id, server.code, profile);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [user.id]);
  await provisionFromSmartup(user.id, server.code, profile);
  expect((await membershipsOf(user.id))[0]?.state).toBe('passive');
});

test('сведения без компании и неверные сведения не создают ничего и не бросают ошибку', async () => {
  const { server, user } = await newSmartupUser();
  expect(await provisionFromSmartup(user.id, server.code, { id: '1001', name: 'Алишер' })).toEqual({ failed: 'no_company' });
  expect(await provisionFromSmartup(user.id, server.code, { ...profile, companyName: 'я'.repeat(400) })).toEqual({ failed: 'invalid_claims' });
  expect(await provisionFromSmartup(user.id, server.code, null)).toEqual({ failed: 'invalid_claims' });
  expect(await provisionFromSmartup(user.id, 'no-such-server', profile)).toEqual({ failed: 'invalid_claims' });
  expect(await membershipsOf(user.id)).toEqual([]);
  expect((await pools.root.query('select 1 from hdu_organizations')).rowCount).toBe(0);
});

test('одинаковый идентификатор компании на разных серверах это разные организации', async () => {
  const a = await newSmartupUser();
  const b = await newSmartupUser();
  const orgA = (await provisionFromSmartup(a.user.id, a.server.code, profile)) as { orgId: string };
  const orgB = (await provisionFromSmartup(b.user.id, b.server.code, profile)) as { orgId: string };
  expect(orgA.orgId).not.toBe(orgB.orgId);
});

test('имя обновляется, адрес из Smartup запоминается, пока нет подтверждённого', async () => {
  const { server, user } = await newSmartupUser();
  await provisionFromSmartup(user.id, server.code, { ...profile, name: 'Алишер Каримов', contactEmail: 'Alisher@Acme.Test' });
  expect((await pools.root.query(`select name, "claimedEmail" from auth."user" where id = $1`, [user.id])).rows[0]).toEqual({
    name: 'Алишер Каримов',
    claimedEmail: 'alisher@acme.test',
  });
  await pools.root.query(`update auth."user" set email = 'confirmed@acme.test', "emailVerified" = true, "claimedEmail" = null where id = $1`, [user.id]);
  await provisionFromSmartup(user.id, server.code, { ...profile, contactEmail: 'other@acme.test' });
  expect((await pools.root.query(`select email, "claimedEmail" from auth."user" where id = $1`, [user.id])).rows[0]).toEqual({
    email: 'confirmed@acme.test',
    claimedEmail: null,
  });
});

test('создание организации и членства записано в журнал от имени системы', async () => {
  const { server, user } = await newSmartupUser();
  const { orgId } = (await provisionFromSmartup(user.id, server.code, profile)) as { orgId: string };
  await provisionFromSmartup(user.id, server.code, profile);
  expect(
    (await pools.root.query(`select action, actor_type from hdc_audit_log where org_id = $1 order by created_on, audit_id`, [orgId])).rows,
  ).toEqual([
    { action: 'org.provisioned', actor_type: 'system' },
    { action: 'member.joined', actor_type: 'system' },
  ]);
});
