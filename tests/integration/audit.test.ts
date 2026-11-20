import { expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { admin, agentL1, asActor, clientA, pools, system } from './helpers/db';

test('запись журнала получает актора от базы, а не от сервиса', async () => {
  await withActor(admin, (tx) =>
    writeAudit(tx, {
      action: 'member.role_changed',
      objectType: 'membership',
      objectId: 'm1',
      diff: { from: 'client_user', to: 'client_admin' },
      ip: '203.0.113.7',
    }),
  );
  const r = await pools.root.query(
    `select actor_type, actor_id, action, object_type, diff, host(ip) as ip, created_on from hdc_audit_log where object_id = 'm1'`,
  );
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({
    actor_type: 'staff',
    actor_id: admin.userId,
    action: 'member.role_changed',
    object_type: 'membership',
    diff: { from: 'client_user', to: 'client_admin' },
    ip: '203.0.113.7',
  });
  expect(Date.now() - new Date(r.rows[0].created_on).getTime()).toBeLessThan(60_000);
});

test('журнал пишется и под ролью hub_auth, фоновая задача записана как система', async () => {
  await withIdentity(system, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'srv-1' }));
  const r = await pools.root.query(`select actor_type, actor_id from hdc_audit_log where object_id = 'srv-1'`);
  expect(r.rows).toEqual([{ actor_type: 'system', actor_id: null }]);
});

test('подделать автора и время записи нельзя', async () => {
  await expect(
    asActor(pools.app, clientA, (c) =>
      c.query(
        `insert into hdc_audit_log (actor_type, actor_id, action, object_type) values ('staff', 'staff-admin-1', 'x', 'y')`,
      ),
    ),
  ).rejects.toThrow(/row-level security/);
  await expect(
    asActor(pools.app, admin, (c) =>
      c.query(`insert into hdc_audit_log (action, object_type, created_on) values ('x', 'y', now() - interval '1 year')`),
    ),
  ).rejects.toThrow(/row-level security/);
});

test('запись без актора отклоняется', async () => {
  for (const pool of [pools.app, pools.auth])
    await expect(pool.query(`insert into hdc_audit_log (action, object_type) values ('x', 'y')`)).rejects.toThrow(
      /row-level security/,
    );
});

test('журнал читает только администратор портала через hub_app, менять и удалять журнал не может никто', async () => {
  await withActor(admin, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'read-1' }));
  // Решение 20 таблицы M1 (решение 0019): без чтения нет экрана журнала FR-ADM-07.
  const read = (actor: Parameters<typeof asActor>[1]) =>
    asActor(pools.app, actor, (c) => c.query('select object_id from hdc_audit_log')).then((r) => r.rows);
  expect(await read(admin)).toEqual([{ object_id: 'read-1' }]);
  for (const actor of [agentL1, { ...agentL1, staffRole: 'care' as const }, clientA, system]) expect(await read(actor), actor.type).toEqual([]);
  await expect(asActor(pools.auth, admin, (c) => c.query('select 1 from hdc_audit_log'))).rejects.toThrow(/permission denied/);
  for (const pool of [pools.app, pools.auth])
    for (const sql of [`update hdc_audit_log set action = 'x'`, 'delete from hdc_audit_log', 'truncate hdc_audit_log'])
      await expect(asActor(pool, admin, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
});

test('запись откатывается вместе с действием', async () => {
  await expect(
    withActor(admin, async (tx) => {
      await writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'rollback-1' });
      throw new Error('сбой после записи');
    }),
  ).rejects.toThrow('сбой после записи');
  expect((await pools.root.query(`select 1 from hdc_audit_log where object_id = 'rollback-1'`)).rowCount).toBe(0);
});

test('секреты, большие объёмы и неизвестные действия в журнал не попадают', async () => {
  const write = (diff: Record<string, unknown>) =>
    withActor(admin, (tx) => writeAudit(tx, { action: 'staff.reset', objectType: 'staff', diff }));
  await expect(write({ password: 'x' })).rejects.toThrow();
  await expect(write({ tokenHash: 'x' })).rejects.toThrow();
  await expect(write({ nested: { clientSecret: 'x' } })).rejects.toThrow();
  await expect(write({ note: 'я'.repeat(5000) })).rejects.toThrow();
  await expect(
    withActor(admin, (tx) => writeAudit(tx, { action: 'made.up' as never, objectType: 'staff' })),
  ).rejects.toThrow();
  await expect(
    withActor(admin, (tx) => writeAudit(tx, { action: 'staff.reset', objectType: 'staff', ip: 'not an ip' })),
  ).rejects.toThrow();
  expect((await pools.root.query('select 1 from hdc_audit_log')).rowCount).toBe(0);
});
