import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Ресурсы сервера (план M9, задача 9, решение 17): scripts/ops/host-watch.sh по таймеру считает доли диска томов базы
// и копий (наибольшую), памяти без кеша и нагрузки процессора на ядро и вызывает hub ops:host-mark. Сценарий запускается
// с подставными df и docker и файлами-образцами /proc/meminfo и /proc/loadavg. Он ничего не меняет на сервере и не
// печатает путей.

const SCRIPT = join(process.cwd(), 'scripts/ops/host-watch.sh');

const DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        163840000  98304000  65536000      61% /
/dev/sdb1        104857600  87031808  17825792      84% /var/backups/smartup-hub
`;
const MEMINFO = `MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    4000000 kB
Buffers:          200000 kB
`;

function sandbox(opts: { df?: string; meminfo?: string; loadavg?: string; nproc?: string; markFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-host-watch-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(root, 'df.out'), opts.df ?? DF);
  stub('df', `echo "$@" >> "${root}/df.args"; cat "${root}/df.out"`);
  stub('docker', `echo "$@" >> "${root}/docker.args"; ${opts.markFails ? 'exit 1' : 'exit 0'}`);
  stub('hostname', 'echo hub-prod');
  writeFileSync(join(root, 'meminfo'), opts.meminfo ?? MEMINFO);
  writeFileSync(join(root, 'loadavg'), opts.loadavg ?? '3.00 2.50 2.00 2/400 12345\n');
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HUB_DIR: root,
      HOST_WATCH_PATHS: '/srv/pg /var/backups/smartup-hub',
      HOST_WATCH_MEMINFO: join(root, 'meminfo'),
      HOST_WATCH_LOADAVG: join(root, 'loadavg'),
      HOST_WATCH_NPROC: opts.nproc ?? '4',
    },
  });
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
  return { result, docker: read('docker.args'), df: read('df.args'), root };
}

test('доли: диск наибольший из томов, память без кеша, процессор на ядро; команда с правильными ключами', () => {
  const { result, docker, df } = sandbox();
  expect(result.status, result.stderr).toBe(0);
  expect(df.trim()).toBe('-P /srv/pg /var/backups/smartup-hub');
  // 84% диска копий, (16 - 4) / 16 = 75% памяти, 3.00 / 4 ядра = 75% процессора.
  expect(docker.trim()).toMatch(/compose -f .+\/compose\.prod\.yaml exec -T web node hub\.mjs ops:host-mark --host hub-prod --disk 84 --mem 75 --cpu 75$/);
});

test('нагрузка выше числа ядер даёт 100, не больше; округление к ближайшему', () => {
  expect(sandbox({ loadavg: '9.70 1 1 1/1 1\n', nproc: '2' }).docker).toMatch(/--cpu 100$/m);
  expect(sandbox({ loadavg: '0.33 1 1 1/1 1\n', nproc: '1', meminfo: 'MemTotal: 1000 kB\nMemAvailable: 334 kB\n' }).docker).toMatch(/--mem 67 --cpu 33$/m);
});

test('вывод без путей томов и имён устройств; отметка не записалась: код 1 и строка в stderr', () => {
  const ok = sandbox();
  expect(`${ok.result.stdout}${ok.result.stderr}`).not.toMatch(/\/srv\/pg|\/dev\/sd|smartup-hub/);
  const failed = sandbox({ markFails: true });
  expect(failed.result.status).toBe(1);
  expect(failed.result.stderr).toContain('host_mark_stale');
  expect(failed.result.stderr).not.toMatch(/\/srv\/pg|\/dev\/sd/);
});

test('неразборчивые данные: сценарий не отправляет отметку и завершается с ошибкой', () => {
  const broken = sandbox({ meminfo: 'нет данных\n' });
  expect(broken.result.status).not.toBe(0);
  expect(broken.docker).toBe('');
});

test('сценарий только читает: в нём нет команд записи на сервер', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  expect(text).not.toMatch(/\b(rm|mv|chmod|chown|systemctl|apt|ufw|iptables|tee)\b|>\s*\//);
});
