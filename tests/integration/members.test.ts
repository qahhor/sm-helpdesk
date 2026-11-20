import { expect, test } from 'vitest';
import { setMemberState } from '@/modules/hdu/api/members';
import { resolveClient } from '@/modules/hdu/api/orgs';
import { clientCtx, clientSession, reload } from './helpers/auth';
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
