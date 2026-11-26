import { beforeEach, expect, test } from 'vitest';
import { type ArchiveState, BACKUP_STALE_HOURS, markBackup, staleBackupKinds } from '@/modules/hdc/api';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { opsAlertText } from '@/modules/hdn/api/ops';
import { collectOpsAlerts, opsWatch } from '@/worker/ops-watch';
import { pools } from './helpers/db';

// Сигнал backup_stale (план подготовки M9, задача 3, решение 6; ТЗ 13.8): ночной копии больше 26 часов, базовой больше
// 8 суток, последний сегмент журнала сохранён больше 26 часов назад. Базовая копия и журнал проверяются только при
// включённом архиве: без архива базовую копию сценарий не делает, и сигнал был бы ложным. В тексте только виды копий.

const SYSTEM = { type: 'system', job: 'ops.watch' } as const;
const HOUR = 3_600_000;
const now = new Date('2026-11-26T08:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const archive = (over: Partial<ArchiveState> = {}): ArchiveState => ({ mode: 'on', failedCount: 0, lastFailedOn: null, lastArchivedOn: ago(1), ...over });

let mail: MemoryEmailProvider;
let chat: string[];
beforeEach(async () => {
  mail = createMemoryEmailProvider();
  chat = [];
  await pools.root.query('delete from hdc_ops_backups');
  await pools.root.query('delete from hdc_ops_alerts');
  await pools.root.query(`delete from hdc_settings where code = 'notify.oncall_emails'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["duty@smartup24.com"]')`);
});

test('пороги: ночная копия 26 часов, базовая 8 суток, журнал 26 часов', () => {
  expect(BACKUP_STALE_HOURS).toEqual({ dump: 26, base: 8 * 24, wal: 26 });
});

test('архив выключен: смотрится только ночная копия', () => {
  const off = archive({ mode: 'off', lastArchivedOn: null });
  expect(staleBackupKinds({ dump: ago(25), base: null }, off, now)).toEqual([]);
  expect(staleBackupKinds({ dump: ago(27), base: null }, off, now)).toEqual(['dump']);
  // Отметки нет совсем: сценарий копий не настроен или не отмечает успех. Это сигнал, а не тишина.
  expect(staleBackupKinds({ dump: null, base: null }, off, now)).toEqual(['dump']);
});

test('архив включён: ночная, базовая и журнал', () => {
  expect(staleBackupKinds({ dump: ago(2), base: ago(24 * 7) }, archive(), now)).toEqual([]);
  expect(staleBackupKinds({ dump: ago(2), base: ago(24 * 8 + 1) }, archive(), now)).toEqual(['base']);
  expect(staleBackupKinds({ dump: ago(2), base: null }, archive(), now)).toEqual(['base']);
  expect(staleBackupKinds({ dump: ago(2), base: ago(24) }, archive({ lastArchivedOn: ago(27) }), now)).toEqual(['wal']);
  expect(staleBackupKinds({ dump: ago(2), base: ago(24) }, archive({ lastArchivedOn: null }), now)).toEqual(['wal']);
  expect(staleBackupKinds({ dump: ago(30), base: ago(24 * 9) }, archive({ lastArchivedOn: ago(30) }), now)).toEqual(['dump', 'base', 'wal']);
});

test('свежая ночная копия при выключенном архиве (база тестов): сигнала нет', async () => {
  await markBackup(SYSTEM, { kind: 'dump', sizeBytes: 100 }, ago(3));
  expect((await collectOpsAlerts(SYSTEM, now)).map((a) => a.code)).not.toContain('backup_stale');
});

test('ночной копии нет или она старше 26 часов: сигнал дежурным раз в час, в тексте только виды копий', async () => {
  const watch = (at: Date) => opsWatch(SYSTEM, at, { provider: mail, oncall: { send: async (text) => void chat.push(text) } });
  expect(await watch(now)).toContain('backup_stale');
  await markBackup(SYSTEM, { kind: 'dump', sizeBytes: 100 }, ago(30));
  expect((await collectOpsAlerts(SYSTEM, now)).find((a) => a.code === 'backup_stale')).toEqual({ code: 'backup_stale', count: 1, kinds: 'dump' });
  // Тот же вид сигнала не чаще раза в час.
  expect(await watch(new Date(now.getTime() + 10 * 60_000))).not.toContain('backup_stale');
  const text = chat.find((line) => line.includes('dump')) ?? '';
  expect(text).toContain('Smartup Hub');
  expect(text).not.toMatch(/r2|https?:|age1|BACKUP_/i);
  expect(mail.sent.some((s) => s.message.text.includes('dump'))).toBe(true);
});

test('текст сигнала на трёх языках называет виды копий и не содержит адресов', () => {
  for (const locale of ['ru', 'uz', 'en'] as const) {
    const text = opsAlertText({ code: 'backup_stale', count: 2, kinds: 'base, wal' }, locale);
    expect(text, locale).toContain('base, wal');
    expect(text, locale).not.toMatch(/https?:|r2-|\{/);
  }
});
