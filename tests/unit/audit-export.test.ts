import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Суточная выгрузка журнала аудита за пределы сервера (вопрос 17, решение владельца 24.11.2026; план W4, задача 4).
// Кто получил доступ к серверу, может стереть журнал в базе: копия в бакете резервных копий остаётся.
// Сценарий запускается с подставными docker, age и rclone.

const SCRIPT = join(process.cwd(), 'scripts/ops/audit-export.sh');

function sandbox(opts: { rcloneFails?: boolean; dockerFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-audit-'));
  const bin = join(root, 'bin');
  const backups = join(root, 'backups');
  for (const dir of [bin, backups]) mkdirSync(dir);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('docker', opts.dockerFails ? 'echo "psql: нет связи" >&2; exit 1' : `echo "$*" >> "${root}/docker.args"; printf 'audit_id,action\\nPLAIN-AUDIT-ROW,user.signed_in\\n'`);
  stub('age', `out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; -r) shift;; esac; shift; done; { printf 'AGE:'; tr 'A-Z' 'N-ZA-M'; } > "$out"`);
  stub('rclone', opts.rcloneFails ? 'echo "rclone: нет связи" >&2; exit 1' : `echo "$@" >> "${root}/rclone.args"; mkdir -p "${root}/remote"; cp "$2" "${root}/remote/"`);
  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HUB_DIR: root, BACKUP_DIR: backups, BACKUP_RECIPIENT: 'age1examplepublickey', BACKUP_REMOTE: 'r2-backups:hub-backups', ...extra },
    });
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
  const state = () => (existsSync(join(backups, 'audit', 'last-exported')) ? readFileSync(join(backups, 'audit', 'last-exported'), 'utf8').trim() : null);
  return { root, backups, run, read, state };
}

test('журнал шифруется до записи на диск и уходит в подкаталог audit; отметка сдвигается после выгрузки', () => {
  const box = sandbox();
  const result = box.run();
  expect(result.status, result.stderr).toBe(0);
  const files = readdirSync(join(box.backups, 'audit')).filter((name) => name.startsWith('audit-'));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^audit-\d{8}T\d{6}Z\.csv\.age$/);
  const content = readFileSync(join(box.backups, 'audit', files[0]!), 'utf8');
  expect(content.startsWith('AGE:')).toBe(true);
  expect(content).not.toContain('PLAIN-AUDIT-ROW');
  expect(box.read('rclone.args')).toContain('r2-backups:hub-backups/audit');
  expect(box.state()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // Первый запуск берёт журнал с начала, запрос читает только таблицу журнала.
  expect(box.read('docker.args')).toContain('hdc_audit_log');
  expect(box.read('docker.args')).toContain("created_on >= '1970-01-01T00:00:00Z'");
});

test('следующий запуск продолжает с отметки прошлого: сутки без выгрузки не теряются', () => {
  const box = sandbox();
  expect(box.run().status).toBe(0);
  const first = box.state();
  expect(box.run().status).toBe(0);
  expect(box.read('docker.args').trim().split('\n').at(-1)).toContain(`created_on >= '${first}'`);
});

test('верхняя граница отстаёт на 15 минут: запись долгой транзакции не теряется между файлами', () => {
  const box = sandbox();
  const before = Date.now();
  expect(box.run().status).toBe(0);
  const to = Date.parse(box.state() ?? '');
  // Отметка это граница выгруженного отрезка: она в прошлом не меньше чем на 14 минут и не больше чем на 17.
  expect(before - to).toBeGreaterThan(14 * 60_000);
  expect(before - to).toBeLessThan(17 * 60_000);
  expect(box.read('docker.args')).toContain(`created_on < '${box.state()}'`);
});

test('сбой выгрузки или чтения базы отметку не сдвигает: следующий запуск возьмёт тот же отрезок', () => {
  const upload = sandbox({ rcloneFails: true });
  expect(upload.run().status).not.toBe(0);
  expect(upload.state()).toBeNull();
  const db = sandbox({ dockerFails: true });
  expect(db.run().status).not.toBe(0);
  expect(db.state()).toBeNull();
  expect(db.read('rclone.args')).toBe('');
});

test('без ключа получателя и с испорченной отметкой сценарий отказывает сразу', () => {
  const box = sandbox();
  expect(box.run({ BACKUP_RECIPIENT: '' }).status).not.toBe(0);
  mkdirSync(join(box.backups, 'audit'), { recursive: true });
  writeFileSync(join(box.backups, 'audit', 'last-exported'), "2026-01-01'; drop table hdc_audit_log; --\n");
  const result = box.run();
  expect(result.status).not.toBe(0);
  expect(box.read('docker.args')).toBe('');
});
