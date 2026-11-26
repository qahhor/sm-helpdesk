import { beforeEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { latestBackups, markBackup } from '@/modules/hdc/api';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Отметки резервных копий (план подготовки M9, задача 3, решение 6; ТЗ 13.7, 13.8). backup.sh и base-backup.sh после
// удачной выгрузки вызывают hub ops:backup-mark --kind dump|base. Пишет только система (команда консоли), читает
// администратор портала; клиент и остальные сотрудники таблицы не видят. Каждая отметка пишется в журнал аудита.

function fakeIo() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { env: { ...process.env }, out: (line: string) => void lines.push(line), err: (line: string) => void errors.push(line), readSecret: async () => '' },
  };
}

let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query('delete from hdc_ops_backups');
});

test('команда пишет отметку ночной копии и запись аудита от системы', async () => {
  const { io, lines } = fakeIo();
  expect(await runCli(['ops:backup-mark', '--kind', 'dump', '--bytes', '734003'], io)).toBe(0);
  expect(lines.join('\n')).toContain('dump');
  const rows = (await pools.root.query(`select kind, size_bytes, finished_on from hdc_ops_backups`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'dump', size_bytes: '734003' });
  expect(Date.now() - new Date(rows[0].finished_on).getTime()).toBeLessThan(60_000);
  const audit = (await pools.root.query(`select actor_type, object_type, diff from hdc_audit_log where action = 'ops.backup_marked'`)).rows;
  expect(audit).toEqual([{ actor_type: 'system', object_type: 'ops_backup', diff: { kind: 'dump', sizeBytes: 734003 } }]);
});

test('базовая копия без размера; неверный вид или размер: код 2, ничего не записано', async () => {
  expect(await runCli(['ops:backup-mark', '--kind', 'base'], fakeIo().io)).toBe(0);
  for (const args of [['--kind', 'wal'], ['--kind', 'dump', '--bytes', '-1'], ['--kind', 'dump', '--bytes', '12x'], []]) {
    const { io, errors } = fakeIo();
    expect(await runCli(['ops:backup-mark', ...args], io), args.join(' ')).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  }
  expect((await pools.root.query(`select kind, size_bytes from hdc_ops_backups`)).rows).toEqual([{ kind: 'base', size_bytes: null }]);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'ops.backup_marked'`)).rows[0].n).toBe(1);
});

test('последняя отметка каждого вида', async () => {
  const system = { type: 'system', job: 'cli' } as const;
  const day = 86_400_000;
  const now = Date.now();
  await markBackup(system, { kind: 'dump', sizeBytes: 10 }, new Date(now - 2 * day));
  await markBackup(system, { kind: 'dump', sizeBytes: 20 }, new Date(now - day));
  await markBackup(system, { kind: 'base' }, new Date(now - 5 * day));
  const latest = await latestBackups(system);
  expect(latest.dump?.getTime()).toBe(now - day);
  expect(latest.base?.getTime()).toBe(now - 5 * day);
});

test('администратор портала читает отметки, клиент и другие сотрудники не видят, никто кроме системы не пишет', async () => {
  await markBackup({ type: 'system', job: 'cli' }, { kind: 'dump', sizeBytes: 1 }, new Date());
  expect((await asActor(pools.app, f.adminStaff.actor, (c) => c.query('select kind from hdc_ops_backups'))).rows).toEqual([{ kind: 'dump' }]);
  for (const actor of [f.aAdmin.actor, f.aUser.actor, f.care.actor, f.l1.actor])
    expect((await asActor(pools.app, actor, (c) => c.query('select * from hdc_ops_backups'))).rows, actor.type).toEqual([]);
  for (const actor of [f.adminStaff.actor, f.aAdmin.actor])
    await expect(asActor(pools.app, actor, (c) => c.query(`insert into hdc_ops_backups (kind, finished_on) values ('dump', now())`))).rejects.toThrow(/row-level security/);
});
