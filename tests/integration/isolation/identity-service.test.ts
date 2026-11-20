import { expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { listMyOrganizations, resolveClient, type ClientContext } from '@/modules/hdu/api/orgs';
import { organizations } from '@/modules/hdu/schema';
import { clientSession } from '../helpers/auth';
import { pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';

// Проверки изоляции на уровне сервисов (ТЗ 15.2): те же правила, что в identity-direct, через функции модуля.

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
