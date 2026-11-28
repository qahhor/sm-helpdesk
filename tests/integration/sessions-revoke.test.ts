import { expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { revokeSessions } from '@/modules/hdu/api/sessions-admin';
import { clientSession } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Завершение сессий для инцидента (план M9, задача 4, решение 9; ASVS V7.4.5): команда hub sessions:revoke по одному
// пользователю, по всем сотрудникам или по всем. Запись session.revoked_bulk с охватом и числом той же транзакцией,
// без адресов других пользователей в журнале. Кнопки в интерфейсе нет.

const SYSTEM = { type: 'system', job: 'cli' } as const;
const count = async (userIds: string[]) => (await pools.root.query(`select count(*)::int as n from auth.session where "userId" = any($1::uuid[])`, [userIds])).rows[0].n as number;
const audits = async () => (await pools.root.query(`select actor_id, object_type, object_id, diff from hdc_audit_log where action = 'session.revoked_bulk' order by created_on`)).rows;

function fakeIo() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { env: { ...process.env }, out: (line: string) => void lines.push(line), err: (line: string) => void errors.push(line), readSecret: async () => '' } };
}

test('по адресу пользователя: только его сессии; журнал с охватом и числом, без адреса', async () => {
  const f = await seedTwoOrgs();
  await clientSession(f.aUser);
  await clientSession(f.aUser);
  await clientSession(f.bUser);
  const email = (await pools.root.query(`select email from auth."user" where id = $1`, [f.aUser.userId])).rows[0].email as string;
  expect(await revokeSessions(SYSTEM, { scope: 'user', email: email.toUpperCase() })).toEqual({ revoked: 2 });
  expect(await count([f.aUser.userId])).toBe(0);
  expect(await count([f.bUser.userId])).toBe(1);
  const rows = await audits();
  expect(rows).toEqual([{ actor_id: null, object_type: 'user', object_id: f.aUser.userId, diff: { scope: 'user', revoked: 2 } }]);
  expect(JSON.stringify(rows)).not.toContain(email);
  await expect(revokeSessions(SYSTEM, { scope: 'user', email: 'nobody@example.invalid' })).rejects.toMatchObject({ code: 'not_found' });
  await expect(revokeSessions(SYSTEM, { scope: 'user', email: 'не адрес' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(revokeSessions(SYSTEM, { scope: 'everyone' })).rejects.toMatchObject({ code: 'invalid_input' });
});

test('по всем сотрудникам: сессии клиентов остаются; по всем: не остаётся ни одной', async () => {
  const f = await seedTwoOrgs();
  await pools.root.query(`delete from auth.session`);
  await clientSession(f.care);
  await clientSession(f.l1);
  await clientSession(f.aUser);
  expect(await revokeSessions(SYSTEM, { scope: 'staff' })).toEqual({ revoked: 2 });
  expect(await count([f.care.userId, f.l1.userId])).toBe(0);
  expect(await count([f.aUser.userId])).toBe(1);
  await clientSession(f.bUser);
  const before = (await pools.root.query(`select count(*)::int as n from auth.session`)).rows[0].n as number;
  expect(before).toBeGreaterThanOrEqual(2);
  expect(await revokeSessions(SYSTEM, { scope: 'all' })).toEqual({ revoked: before });
  expect((await pools.root.query(`select count(*)::int as n from auth.session`)).rows[0].n).toBe(0);
  expect((await audits()).map((r) => [r.object_type, r.object_id, r.diff])).toEqual([
    ['session', null, { scope: 'staff', revoked: 2 }],
    ['session', null, { scope: 'all', revoked: before }],
  ]);
});

test('сотрудник и клиент команду не вызывают: только система (консоль на сервере)', async () => {
  const f = await seedTwoOrgs();
  await expect(revokeSessions(f.adminStaff.actor as never, { scope: 'all' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(revokeSessions(f.aAdmin.actor as never, { scope: 'all' })).rejects.toMatchObject({ code: 'forbidden' });
});

test('hub sessions:revoke: ровно один охват, печатает число', async () => {
  const f = await seedTwoOrgs();
  await clientSession(f.care);
  const email = (await pools.root.query(`select email from auth."user" where id = $1`, [f.care.userId])).rows[0].email as string;
  const both = fakeIo();
  expect(await runCli(['sessions:revoke', '--staff', '--all'], both.io)).toBe(2);
  const none = fakeIo();
  expect(await runCli(['sessions:revoke'], none.io)).toBe(2);
  const one = fakeIo();
  expect(await runCli(['sessions:revoke', '--user', email], one.io)).toBe(0);
  expect(one.lines).toEqual(['Завершено сессий: 1 (пользователь).']);
  await pools.root.query(`delete from auth.session`);
  const all = fakeIo();
  expect(await runCli(['sessions:revoke', '--all'], all.io)).toBe(0);
  expect(all.lines).toEqual(['Завершено сессий: 0 (все).']);
});
