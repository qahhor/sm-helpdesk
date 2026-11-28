import { beforeEach, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { cleanupHostMarks, HOST_MARK_KEEP_DAYS, HOST_MARK_STALE_MIN, HOST_PRESSURE_PCT, hostAlerts, latestHostMarks, markHost } from '@/modules/hdc/api';
import { opsAlertText } from '@/modules/hdn/api/ops';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { collectOpsAlerts, opsWatch } from '@/worker/ops-watch';
import { asActor, pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Ресурсы сервера без агента хостинга (план M9, задача 9, решение 17; ТЗ 13.8). Таймер systemd раз в 5 минут
// запускает scripts/ops/host-watch.sh, тот вызывает hub ops:host-mark с долями диска, памяти и процессора. ops.watch
// даёт host_pressure при 80% и выше по любому показателю и host_mark_stale, если отметок нет 15 минут; до первой
// отметки (таймер ещё не поставлен) сигнала нет. В тексте только показатель и число.

const SYSTEM = { type: 'system', job: 'ops.watch' } as const;
const MINUTE = 60_000;
const now = new Date('2026-11-27T08:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);

let mail: MemoryEmailProvider;
let chat: string[];
let f: Fixture;
beforeEach(async () => {
  f = await seedTwoOrgs();
  mail = createMemoryEmailProvider();
  chat = [];
  await pools.root.query('delete from hdc_ops_host_marks');
  await pools.root.query('delete from hdc_ops_alerts');
  await pools.root.query(`delete from hdc_settings where code = 'notify.oncall_emails'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["duty@smartup24.com"]')`);
});

const codes = async () => (await collectOpsAlerts(SYSTEM, now, { searchWriter: null })).map((a) => a.code).filter((c) => c.startsWith('host_'));

test('пороги: 80% и 15 минут', () => {
  expect(HOST_PRESSURE_PCT).toBe(80);
  expect(HOST_MARK_STALE_MIN).toBe(15);
});

test('до первой отметки сигналов о ресурсах нет: таймер ещё не поставлен', async () => {
  expect(await codes()).toEqual([]);
});

test('79% по всем показателям не сигнал; 80% по любому даёт host_pressure с показателем и числом', async () => {
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 79, memPct: 79, cpuPct: 79, at: ago(1) });
  expect(await codes()).toEqual([]);
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 80, memPct: 40, cpuPct: 95, at: ago(1) });
  const alerts = (await collectOpsAlerts(SYSTEM, now, { searchWriter: null })).filter((a) => a.code === 'host_pressure');
  expect(alerts).toEqual([{ code: 'host_pressure', count: 2, kinds: 'disk 80%, cpu 95%' }]);
  const text = opsAlertText(alerts[0]!);
  expect(text).toContain('disk 80%, cpu 95%');
  expect(text).not.toContain('hub-prod');
  // Одна строка на сервер: новая отметка заменяет прежнюю.
  expect((await pools.root.query('select count(*)::int as n from hdc_ops_host_marks')).rows[0].n).toBe(1);
});

test('сигнал host_pressure уходит раз в час на вид', async () => {
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 91, memPct: 10, cpuPct: 10, at: ago(1) });
  const deps = { provider: mail, oncall: { send: async (text: string) => void chat.push(text) }, searchWriter: null };
  expect(await opsWatch(SYSTEM, now, deps)).toContain('host_pressure');
  expect(await opsWatch(SYSTEM, new Date(now.getTime() + 30 * MINUTE), deps)).not.toContain('host_pressure');
  expect(chat.filter((t) => t.includes('disk 91%'))).toHaveLength(1);
});

test('отметки нет 15 минут после первой: host_mark_stale; свежая отметка снимает', async () => {
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 10, memPct: 10, cpuPct: 10, at: ago(14) });
  expect(await codes()).toEqual([]);
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 10, memPct: 10, cpuPct: 10, at: ago(16) });
  expect(await codes()).toEqual(['host_mark_stale']);
  // Устаревшая отметка с высокой долей уже не говорит о нагрузке сейчас: только о том, что отметок нет.
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 99, memPct: 10, cpuPct: 10, at: ago(20) });
  expect(await codes()).toEqual(['host_mark_stale']);
  const stale = (await collectOpsAlerts(SYSTEM, now, { searchWriter: null })).find((a) => a.code === 'host_mark_stale')!;
  expect(opsAlertText(stale)).not.toContain('hub-prod');
});

test('проверка входа: доли от 0 до 100, имя сервера по образцу, только система', async () => {
  for (const input of [
    { host: 'hub-prod', diskPct: 101, memPct: 1, cpuPct: 1 },
    { host: 'hub-prod', diskPct: -1, memPct: 1, cpuPct: 1 },
    { host: 'hub-prod', diskPct: 1.5, memPct: 1, cpuPct: 1 },
    { host: 'hub prod; rm', diskPct: 1, memPct: 1, cpuPct: 1 },
  ])
    await expect(markHost(SYSTEM, input)).rejects.toThrow();
  await expect(markHost(f.adminStaff.actor as never, { host: 'hub-prod', diskPct: 1, memPct: 1, cpuPct: 1 })).rejects.toThrow();
});

test('таблицу не читают и не пишут клиент, сотрудник и агент', async () => {
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 10, memPct: 10, cpuPct: 10 });
  for (const actor of [f.aAdmin.actor, f.adminStaff.actor, f.care.actor, { type: 'agent', userId: f.l1.userId, tokenId: '00000000-0000-7000-8000-000000000001', tools: [], ticketId: null }] as const) {
    expect(await asActor(pools.app, actor as never, (c) => c.query('select * from hdc_ops_host_marks').then((r) => r.rowCount))).toBe(0);
    await expect(
      asActor(pools.app, actor as never, (c) => c.query(`insert into hdc_ops_host_marks (host, disk_pct, mem_pct, cpu_pct, marked_on) values ('x', 1, 1, 1, now())`)),
    ).rejects.toThrow();
  }
  expect((await latestHostMarks(SYSTEM)).map((m) => m.host)).toEqual(['hub-prod']);
});

test('hub ops:host-mark пишет отметку; неверные доли: код 2', async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { env: { ...process.env }, out: (l: string) => void lines.push(l), err: (l: string) => void errors.push(l), readSecret: async () => '' };
  expect(await runCli(['ops:host-mark', '--host', 'hub-staging', '--disk', '42', '--mem', '63', '--cpu', '7'], io)).toBe(0);
  expect(lines).toEqual(['Отметка ресурсов записана: диск 42%, память 63%, процессор 7%.']);
  expect((await pools.root.query(`select host, disk_pct, mem_pct, cpu_pct from hdc_ops_host_marks`)).rows).toEqual([{ host: 'hub-staging', disk_pct: 42, mem_pct: 63, cpu_pct: 7 }]);
  expect(await runCli(['ops:host-mark', '--disk', '142', '--mem', '1', '--cpu', '1'], io)).toBe(2);
  expect(await runCli(['ops:host-mark', '--disk', '1'], io)).toBe(2);
  expect(hostAlerts([], now)).toEqual([]);
});

test('hub ops:host-mark без --host: код 2, имя контейнера не подставляется (независимая проверка M9, M2)', async () => {
  const errors: string[] = [];
  const io = { env: { ...process.env }, out: () => undefined, err: (l: string) => void errors.push(l), readSecret: async () => '' };
  expect(await runCli(['ops:host-mark', '--disk', '42', '--mem', '63', '--cpu', '7'], io)).toBe(2);
  expect(await runCli(['ops:host-mark', '--host', 'Bad_Host!', '--disk', '42', '--mem', '63', '--cpu', '7'], io)).toBe(2);
  expect((await pools.root.query(`select host from hdc_ops_host_marks`)).rows).toEqual([]);
});

test('ночная очистка убирает отметки старше 7 суток: снятый сервер не даёт вечный host_mark_stale (M2)', async () => {
  expect(HOST_MARK_KEEP_DAYS).toBe(7);
  await markHost(SYSTEM, { host: 'hub-old', diskPct: 10, memPct: 10, cpuPct: 10, at: ago(7 * 24 * 60 + 1) });
  await markHost(SYSTEM, { host: 'hub-week', diskPct: 10, memPct: 10, cpuPct: 10, at: ago(6 * 24 * 60) });
  await markHost(SYSTEM, { host: 'hub-prod', diskPct: 10, memPct: 10, cpuPct: 10, at: ago(1) });
  expect(await cleanupHostMarks(SYSTEM, now)).toBe(1);
  expect((await latestHostMarks(SYSTEM)).map((m) => m.host).sort()).toEqual(['hub-prod', 'hub-week']);
  // Сотрудник и клиент строк не видят и не удаляют.
  await expect(cleanupHostMarks(f.aAdmin.actor as never, now)).rejects.toThrow();
});
