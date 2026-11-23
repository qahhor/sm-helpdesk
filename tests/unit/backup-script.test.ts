import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Ночная копия базы (аудит 23.11.2026, находка S5; ТЗ 13.7): копия шифруется до записи на диск и до выгрузки.
// Сценарий scripts/ops/backup.sh запускается с подставными командами docker, age и rclone.

const SCRIPT = join(process.cwd(), 'scripts/ops/backup.sh');

function sandbox(opts: { dumpFails?: boolean; emptyDump?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-backup-'));
  const bin = join(root, 'bin');
  const backups = join(root, 'backups');
  mkdirSync(bin);
  mkdirSync(backups);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // pg_dump через docker compose exec: печатает копию в поток.
  stub('docker', opts.dumpFails ? 'echo "pg_dump: ошибка" >&2; exit 1' : opts.emptyDump ? 'exit 0' : `printf 'PLAIN-DUMP-%.0s' {1..200}`);
  // age читает поток и пишет зашифрованный файл в -o: открытого текста на диске нет.
  stub('age', `echo "$@" >> "${root}/age.args"; out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done; { printf 'AGE:'; cat | tr 'A-Z' 'N-ZA-M'; } > "$out"`);
  stub('rclone', `echo "$@" >> "${root}/rclone.args"`);
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HUB_DIR: root,
        BACKUP_DIR: backups,
        BACKUP_RECIPIENT: 'age1examplepublickey',
        BACKUP_REMOTE: 'r2-backups:hub-backups',
        ...env,
      },
    });
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
  return { root, backups, run, read };
}

test('копия шифруется до записи на диск и выгружается зашифрованной', () => {
  const box = sandbox();
  const result = box.run();
  expect(result.status, result.stderr).toBe(0);
  const files = readdirSync(box.backups).filter((name) => name.startsWith('hub-'));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^hub-\d{8}T\d{6}Z\.dump\.age$/);
  const content = readFileSync(join(box.backups, files[0]!), 'utf8');
  expect(content.startsWith('AGE:')).toBe(true);
  expect(content).not.toContain('PLAIN-DUMP');
  // Шифрование открытым ключом получателя: закрытого ключа на сервере нет.
  expect(box.read('age.args')).toContain('-r age1examplepublickey');
  expect(box.read('rclone.args')).toContain(`copy ${join(box.backups, files[0]!)} r2-backups:hub-backups`);
  expect(existsSync(join(box.backups, 'last-success'))).toBe(true);
});

test('без ключа получателя и без места выгрузки сценарий отказывает и ничего не пишет', () => {
  for (const missing of ['BACKUP_RECIPIENT', 'BACKUP_REMOTE']) {
    const box = sandbox();
    const result = box.run({ [missing]: '' });
    expect(result.status, missing).not.toBe(0);
    expect(readdirSync(box.backups)).toEqual([]);
    expect(box.read('rclone.args')).toBe('');
  }
});

test('сбой pg_dump или пустая копия: ошибка, файла нет, выгрузки нет, отметки успеха нет', () => {
  for (const opts of [{ dumpFails: true }, { emptyDump: true }]) {
    const box = sandbox(opts);
    const result = box.run();
    expect(result.status, JSON.stringify(opts)).not.toBe(0);
    expect(readdirSync(box.backups)).toEqual([]);
    expect(box.read('rclone.args')).toBe('');
  }
});

test('копии старше срока хранения удаляются, свежие остаются', () => {
  const box = sandbox();
  const old = join(box.backups, 'hub-20260101T023000Z.dump.age');
  const recent = join(box.backups, 'hub-20261120T023000Z.dump.age');
  writeFileSync(old, 'x');
  writeFileSync(recent, 'x');
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  utimesSync(old, days(20), days(20));
  utimesSync(recent, days(3), days(3));
  expect(box.run({ BACKUP_KEEP_DAYS: '14' }).status).toBe(0);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});
