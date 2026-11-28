import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { auditServer, formatAudit } from '../../scripts/ops/server-audit.mjs';

// Проверка защиты сервера ТЗ 13.9 (план M9, задача 10, решение 16): scripts/ops/server-audit.mjs на файлах-образцах.
// Вход SSH только по ключу, root и пароль выключены, обновления безопасности включены, наружу только 80 и 443, Caddy
// только для адресов Cloudflare, службы портала не от root и с файловой системой только для чтения, образы по digest.
// Вывод без значений переменных окружения контейнеров.

type Container = { Config: { Image: string; User: string; Env: string[] }; HostConfig: { ReadonlyRootfs: boolean; PortBindings: Record<string, unknown[]> } };

const DIR = join(process.cwd(), 'tests/fixtures/ops/server-good');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const good = () => ({
  sshd: [read('sshd_config.d/60-hub.conf'), read('sshd_config')],
  autoUpgrades: read('20auto-upgrades'),
  containers: JSON.parse(read('docker-inspect.json')) as Container[],
});
const failing = (items: ReturnType<typeof auditServer>) => items.filter((i) => i.status === 'нет').map((i) => i.item);

test('правильный сервер: все пункты "есть", у инфраструктуры исключения с причиной', () => {
  const items = auditServer(good());
  expect(failing(items)).toEqual([]);
  expect(items.filter((i) => i.status === 'исключение').map((i) => i.item)).toEqual([
    'Контейнер caddy: не от root',
    'Контейнер caddy: файловая система только для чтения',
    'Контейнер postgres: не от root',
    'Контейнер postgres: файловая система только для чтения',
  ]);
  expect(items.map((i) => i.item)).toEqual(expect.arrayContaining(['SSH: вход по паролю выключен', 'SSH: вход root выключен', 'Автоматические обновления безопасности включены', 'Контейнер web: не от root', 'Caddy: только адреса Cloudflare']));
});

test('PasswordAuthentication yes, root разрешён, нет файла обновлений: "нет" по пунктам', () => {
  const files = good();
  files.sshd = ['PasswordAuthentication yes\nPermitRootLogin prohibit-password\n'];
  files.autoUpgrades = null as unknown as string;
  expect(failing(auditServer(files))).toEqual(['SSH: вход по паролю выключен', 'SSH: вход root выключен', 'Автоматические обновления безопасности включены']);
  // Без явной строки sshd разрешает пароль: это тоже "нет".
  files.sshd = ['Port 22\n'];
  expect(failing(auditServer(files))).toContain('SSH: вход по паролю выключен');
  // Первое значение вне блока Match решает, как у sshd.
  files.sshd = ['PasswordAuthentication no\nPermitRootLogin no\nMatch User deploy\n  PasswordAuthentication yes\n'];
  expect(failing(auditServer(files))).not.toContain('SSH: вход по паролю выключен');
});

test('контейнер без read_only или с user root, образ без digest, лишний порт: "нет"', () => {
  const files = good();
  const web = files.containers[1]!;
  web.HostConfig.ReadonlyRootfs = false;
  web.Config.User = 'root';
  web.Config.Image = 'ghcr.io/example/smartup-hub:latest';
  web.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] };
  expect(failing(auditServer(files))).toEqual([
    'Контейнер web: наружу только 80 и 443',
    'Контейнер web: образ по digest',
    'Контейнер web: не от root',
    'Контейнер web: файловая система только для чтения',
  ]);
  files.containers[2]!.Config.User = '';
  expect(failing(auditServer(files))).toContain('Контейнер worker: не от root');
});

test('Caddy пускает все адреса: "нет" с пояснением про staging; значение переменной не печатается', () => {
  const files = good();
  files.containers[0]!.Config.Env = ['TRUSTED_PROXIES=0.0.0.0/0 ::/0'];
  const items = auditServer(files);
  expect(failing(items)).toEqual(['Caddy: только адреса Cloudflare']);
  expect(formatAudit(items).join('\n')).not.toContain('0.0.0.0/0');
});

test('вывод не содержит значений переменных окружения контейнеров; запуск по образцам: код 0, только чтение', () => {
  const run = spawnSync(process.execPath, ['scripts/ops/server-audit.mjs', '--dir', DIR], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('Итог: все пункты есть');
  for (const secret of ['SECRET-APP-PASSWORD', 'SECRET-SESSION-KEY', 'SECRET-ANTHROPIC-KEY', 'hub_app', '173.245.48.0']) expect(run.stdout).not.toContain(secret);
  const source = readFileSync('scripts/ops/server-audit.mjs', 'utf8');
  expect(source).not.toMatch(/writeFileSync|rmSync|unlinkSync|'(rm|stop|restart|kill|exec|run)'/);
});
