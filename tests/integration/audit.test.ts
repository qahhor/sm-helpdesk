import { expect, test } from 'vitest';
import { withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { listAudit } from '@/modules/hdc/api';
import { staffCtx } from './helpers/auth';
import { admin, agentL1, asActor, clientA, pools, system } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

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
  // Составные имена одноразовых кодов тоже секрет (итоговая проверка доработки).
  for (const key of ['codeHash', 'otp', 'backupCodes', 'api_key', 'refresh_token', 'X-Api-Key', 'cookie', 'linkCode', 'loginCode', 'recovery_code', 'verificationCode', 'authCode'])
    await expect(write({ [key]: 'x' }), key).rejects.toThrow();
  expect((await pools.root.query('select 1 from hdc_audit_log')).rowCount).toBe(0);
});

test('обычные поля со словами code и pass записываются (проверка main, Q4)', async () => {
  const write = (diff: Record<string, unknown>) =>
    withActor(admin, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', diff }));
  await write({ code: 'mock', serverCode: 'acme', state: 'passive', companyCode: '501' });
  expect((await pools.root.query('select diff from hdc_audit_log')).rows).toEqual([{ diff: { code: 'mock', serverCode: 'acme', state: 'passive', companyCode: '501' } }]);
});

// --- Просмотр журнала (задача 20, FR-ADM-07) ---

test('список журнала фильтруется и листается без пропусков и повторов', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  for (let i = 0; i < 120; i++)
    await withActor(f.adminStaff.actor, (tx) =>
      writeAudit(tx, { action: i % 2 ? 'server.added' : 'server.disabled', objectType: 'server', objectId: `p-${i}` }),
    );
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof listAudit>> = await listAudit(ctx, { objectType: 'server', action: 'server.added', cursor: cursor ?? undefined });
    expect(page.items.length).toBeLessThanOrEqual(50);
    seen.push(...page.items.map((row) => row.objectId ?? ''));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(2);
  expect(seen).toHaveLength(60);
  expect(new Set(seen).size).toBe(60);
  // От новых к старым.
  expect(seen[0]).toBe('p-119');
  await expect(listAudit(staffCtx(f.care), {})).rejects.toMatchObject({ code: 'forbidden' });
  await expect(listAudit(ctx, { action: 'drop table' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(listAudit(ctx, { cursor: 'не курсор' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('строка журнала называет автора и организацию, период по умолчанию последние 7 дней', async () => {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  await withActor(f.adminStaff.actor, (tx) =>
    writeAudit(tx, { action: 'member.role_changed', objectType: 'membership', objectId: 'm-1', orgId: f.orgA.orgId, diff: { from: 'client_user', to: 'client_admin' }, ip: '203.0.113.5' }),
  );
  await pools.root.query(
    `insert into hdc_audit_log (actor_type, action, object_type, object_id, created_on) values ('system', 'server.added', 'server', 'old-1', now() - interval '8 days')`,
  );
  const { items } = await listAudit(ctx, {});
  expect(items.map((row) => row.objectId)).toEqual(['m-1']);
  expect(items[0]).toMatchObject({
    actorType: 'staff',
    actorId: f.adminStaff.userId,
    actorName: f.adminStaff.name,
    action: 'member.role_changed',
    orgId: f.orgA.orgId,
    orgName: f.orgA.name,
    diff: { from: 'client_user', to: 'client_admin' },
    ip: '203.0.113.5',
  });
  const old = await listAudit(ctx, { from: new Date(Date.now() - 10 * 86400e3).toISOString() });
  expect(old.items.map((row) => row.objectId)).toEqual(['m-1', 'old-1']);
  expect((await listAudit(ctx, { orgId: f.orgB.orgId })).items).toEqual([]);
  expect((await listAudit(ctx, { actorId: f.adminStaff.userId })).items).toHaveLength(1);
  expect((await listAudit(ctx, { to: new Date(Date.now() - 86400e3).toISOString() })).items).toEqual([]);
});

test('адрес запроса из актора попадает в журнал сам: действия администратора записываются с адресом (проверка main, S5)', async () => {
  await withActor({ ...admin, ip: '203.0.113.9' }, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'ip-1' }));
  await withIdentity({ ...admin, ip: '2001:db8::7' }, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'ip-2' }));
  // Явно переданный адрес важнее адреса актора; без адреса пусто.
  await withActor({ ...admin, ip: '203.0.113.9' }, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'ip-3', ip: '198.51.100.1' }));
  await withActor(admin, (tx) => writeAudit(tx, { action: 'server.added', objectType: 'server', objectId: 'ip-4' }));
  const rows = (await pools.root.query(`select object_id, host(ip) as ip from hdc_audit_log where object_id like 'ip-%' order by object_id`)).rows;
  expect(rows).toEqual([
    { object_id: 'ip-1', ip: '203.0.113.9' },
    { object_id: 'ip-2', ip: '2001:db8::7' },
    { object_id: 'ip-3', ip: '198.51.100.1' },
    { object_id: 'ip-4', ip: null },
  ]);
});
