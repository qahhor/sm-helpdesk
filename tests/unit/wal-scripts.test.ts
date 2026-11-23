import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

// Непрерывный архив базы (аудит 23.11.2026, находка O5; ТЗ 13.7; план W2, задача 11). PostgreSQL складывает
// сегменты журнала в каталог на сервере, сценарий wal-ship.sh шифрует их и выгружает, base-backup.sh делает базовую
// копию. Вместе они дают восстановление на момент времени. Сценарии запускаются с подставными age, rclone и docker.

const SHIP = join(process.cwd(), 'scripts/ops/wal-ship.sh');
const BASE = join(process.cwd(), 'scripts/ops/base-backup.sh');
const RESTORE = join(process.cwd(), 'scripts/ops/restore-pitr.sh');
const SEGMENT_A = '000000010000000000000003';
const SEGMENT_B = '000000010000000000000004';

function sandbox(opts: { ageFails?: boolean; rcloneFails?: boolean; emptyBase?: boolean; archiveOff?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-wal-'));
  const bin = join(root, 'bin');
  const wal = join(root, 'wal-archive');
  const backups = join(root, 'backups');
  for (const dir of [bin, wal, backups]) mkdirSync(dir);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // age -r <ключ> -o <файл> [вход]: вход из файла или из потока, на выходе не открытый текст.
  stub(
    'age',
    opts.ageFails
      ? 'echo "age: ошибка" >&2; exit 1'
      : `echo "$@" >> "${root}/age.args"; out=""; in=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; -r) shift;; *) in="$1";; esac; shift; done; { printf 'AGE:'; if [ -n "$in" ]; then tr 'A-Z' 'N-ZA-M' < "$in"; else tr 'A-Z' 'N-ZA-M'; fi; } > "$out"`,
  );
  stub('rclone', opts.rcloneFails ? `echo "$@" >> "${root}/rclone.args"; echo "rclone: нет связи" >&2; exit 1` : `echo "$@" >> "${root}/rclone.args"; if [ "$1" = "copy" ]; then mkdir -p "${root}/remote"; cp "$2" "${root}/remote/"; fi`);
  // docker compose exec: вопрос о режиме архива (psql) или поток базовой копии (pg_basebackup).
  const mode = opts.archiveOff ? 'off' : 'on';
  stub('docker', `case "$*" in *archive_mode*) echo ${mode};; *) ${opts.emptyBase ? 'exit 0' : "printf 'PLAIN-BASE-%.0s' {1..200}"};; esac`);
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HUB_DIR: root,
    WAL_DIR: wal,
    BACKUP_DIR: backups,
    BACKUP_RECIPIENT: 'age1examplepublickey',
    BACKUP_REMOTE: 'r2-backups:hub-backups',
    ...extra,
  });
  const run = (script: string, extra: Record<string, string> = {}, args: string[] = []) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: env(extra) });
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
  const segment = (name: string, text = 'PLAIN-WAL-SEGMENT') => writeFileSync(join(wal, name), text);
  return { root, wal, backups, run, read, segment };
}

test('сегмент журнала шифруется до выгрузки и удаляется с сервера только после неё', () => {
  const box = sandbox();
  box.segment(SEGMENT_A);
  box.segment(SEGMENT_B);
  box.segment(`${SEGMENT_B}.00000028.backup`, 'START WAL LOCATION');
  const result = box.run(SHIP);
  expect(result.status, result.stderr).toBe(0);
  const shipped = readdirSync(join(box.root, 'remote')).sort();
  expect(shipped).toEqual([`${SEGMENT_A}.age`, `${SEGMENT_B}.00000028.backup.age`, `${SEGMENT_B}.age`]);
  for (const name of shipped) {
    const content = readFileSync(join(box.root, 'remote', name), 'utf8');
    expect(content.startsWith('AGE:')).toBe(true);
    expect(content).not.toContain('PLAIN-WAL');
  }
  expect(box.read('age.args')).toContain('-r age1examplepublickey');
  expect(box.read('rclone.args')).toContain('r2-backups:hub-backups/wal');
  // На сервере сегментов не осталось, отметка последней выгрузки стоит.
  expect(readdirSync(box.wal).filter((name) => /^[0-9A-F]{24}/.test(name))).toEqual([]);
  expect(existsSync(join(box.wal, 'last-shipped'))).toBe(true);
});

test('сбой выгрузки оставляет сегмент на сервере: следующий запуск повторит', () => {
  const box = sandbox({ rcloneFails: true });
  box.segment(SEGMENT_A);
  box.segment(SEGMENT_B);
  const result = box.run(SHIP);
  expect(result.status).not.toBe(0);
  expect(readdirSync(box.wal).filter((name) => /^[0-9A-F]{24}$/.test(name)).sort()).toEqual([SEGMENT_A, SEGMENT_B]);
  expect(existsSync(join(box.wal, 'last-shipped'))).toBe(false);
  // Порядок сохраняется: после сбоя первого сегмента второй не выгружается раньше него.
  expect(box.read('rclone.args').split('\n').filter(Boolean)).toHaveLength(1);
});

test('сбой шифрования ничего не выгружает; без ключа получателя сценарий отказывает сразу', () => {
  const broken = sandbox({ ageFails: true });
  broken.segment(SEGMENT_A);
  expect(broken.run(SHIP).status).not.toBe(0);
  expect(broken.read('rclone.args')).toBe('');
  expect(existsSync(join(broken.wal, SEGMENT_A))).toBe(true);
  const box = sandbox();
  box.segment(SEGMENT_A);
  for (const missing of ['BACKUP_RECIPIENT', 'BACKUP_REMOTE']) {
    const result = box.run(SHIP, { [missing]: '' });
    expect(result.status, missing).not.toBe(0);
    expect(result.stderr, missing).toContain(missing);
  }
  expect(box.read('rclone.args')).toBe('');
});

test('недописанный сегмент и посторонние файлы не выгружаются; пустой каталог не ошибка', () => {
  const box = sandbox();
  expect(box.run(SHIP).status).toBe(0);
  box.segment(`${SEGMENT_A}.tmp`);
  box.segment('notes.txt');
  box.segment('../evil');
  const result = box.run(SHIP);
  expect(result.status, result.stderr).toBe(0);
  expect(box.read('rclone.args')).toBe('');
  expect(existsSync(join(box.wal, `${SEGMENT_A}.tmp`))).toBe(true);
});

test('базовая копия шифруется потоком до записи на диск и выгружается', () => {
  const box = sandbox();
  const result = box.run(BASE);
  expect(result.status, result.stderr).toBe(0);
  const files = readdirSync(join(box.backups, 'base')).filter((name) => name.startsWith('base-'));
  expect(files).toHaveLength(1);
  expect(existsSync(join(box.backups, 'base', 'last-success'))).toBe(true);
  expect(files[0]).toMatch(/^base-\d{8}T\d{6}Z\.tar\.age$/);
  const content = readFileSync(join(box.backups, 'base', files[0]!), 'utf8');
  expect(content.startsWith('AGE:')).toBe(true);
  expect(content).not.toContain('PLAIN-BASE');
  expect(box.read('rclone.args')).toContain('r2-backups:hub-backups/base');
  const empty = sandbox({ emptyBase: true });
  const refused = empty.run(BASE);
  expect(refused.status).not.toBe(0);
  expect(empty.read('rclone.args')).toBe('');
});

test('базовая копия при выключенном архиве журнала не делается: без сегментов она не восстанавливается (проверка волны 2)', () => {
  const box = sandbox({ archiveOff: true });
  const result = box.run(BASE);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('PG_ARCHIVE_MODE');
  expect(box.read('rclone.args')).toBe('');
  // Сценарий остановился до работы с каталогом копий.
  expect(existsSync(join(box.backups, 'base'))).toBe(false);
});

test('восстановление на момент времени отказывает без нужных аргументов и не трогает непустой каталог', () => {
  const box = sandbox();
  expect(box.run(RESTORE).status).not.toBe(0);
  const work = join(box.root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'old-file'), 'x');
  writeFileSync(join(box.root, 'base.tar.age'), 'AGE:x');
  writeFileSync(join(box.root, 'key.txt'), 'AGE-SECRET-KEY-1X');
  const bad = box.run(RESTORE, { BACKUP_IDENTITY: join(box.root, 'key.txt') }, [join(box.root, 'base.tar.age'), box.wal, 'вчера', work]);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('ГГГГ-ММ-ДД');
  const busy = box.run(RESTORE, { BACKUP_IDENTITY: join(box.root, 'key.txt') }, [join(box.root, 'base.tar.age'), box.wal, '2026-11-23 10:15:00+05', work]);
  expect(busy.status).not.toBe(0);
  expect(busy.stderr).toContain('не пуст');
  expect(existsSync(join(work, 'old-file'))).toBe(true);
});

test('архив журнала в настройках базы выключен по умолчанию и включается переменной', () => {
  const compose = parse(readFileSync('compose.prod.yaml', 'utf8'));
  const pg = compose.services.postgres as { command: string[]; volumes: string[] };
  const setting = (name: string) => pg.command.find((part) => part.startsWith(`${name}=`));
  expect(setting('archive_mode')).toBe('archive_mode=${PG_ARCHIVE_MODE:-off}');
  expect(setting('archive_timeout')).toBe('archive_timeout=300');
  // Сегмент появляется в каталоге целиком: сначала под временным именем, затем переименование.
  // Сегмент и каталог записываются на диск до ответа базе (sync): после внезапной перезагрузки в архиве не окажется
  // обрезанный файл под именем готового сегмента (проверка волны 2).
  expect(setting('archive_command')).toBe(
    'archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f.tmp && sync /wal-archive/%f.tmp && mv /wal-archive/%f.tmp /wal-archive/%f && sync /wal-archive',
  );
  expect(pg.volumes).toContain('./wal-archive:/wal-archive');
});
