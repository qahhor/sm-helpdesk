#!/usr/bin/env node
// Проверка защиты сервера по ТЗ 13.9 (план M9, задача 10, решение 16). Только читает: настройки SSH, автоматические
// обновления безопасности, контейнеры Docker (порты, пользователь, файловая система, образ по digest) и список
// доверенных прокси Caddy. Печатает по строке на пункт: "есть", "нет" или "исключение" с пояснением, без значений
// переменных окружения, секретов и адресов. Код завершения 1, если есть хоть одно "нет".
//
// Запуск на сервере: sudo node /opt/smartup-hub/server-audit.mjs (docs/runbooks/launch.md, раздел 1). С ключом
// --dir <каталог> читает файлы-образцы вместо сервера: sshd_config, sshd_config.d/*.conf, 20auto-upgrades,
// docker-inspect.json (так его проверяют модульные тесты).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Службы портала: файловая система только для чтения; кроме tei и typesense ещё и не от root. */
const PORTAL_SERVICES = ['web', 'web2', 'worker', 'migrate', 'bootstrap'];
const READ_ONLY_SERVICES = [...PORTAL_SERVICES, 'tei', 'typesense'];
/** Образы инфраструктуры сами сбрасывают права или пишут на свои тома: исключение, записанное в памятке запуска. */
const INFRA_EXCEPTIONS = { caddy: 'слушает 80 и 443, пишет сертификаты на свой том', postgres: 'пишет данные на свой том', clamav: 'обновляет базы сигнатур на своём томе', 'tei-download': 'разовая загрузка весов модели' };
const ALLOWED_PORTS = new Set(['80/tcp', '443/tcp']);

/**
 * @typedef {{ item: string; status: 'есть' | 'нет' | 'исключение'; note?: string }} AuditItem
 * @typedef {{ sshd: string[]; autoUpgrades: string | null; containers: unknown[] }} AuditFiles
 */

/**
 * Значение ключа sshd_config: первое вхождение вне блоков Match (так читает sshd). Файлы в порядке чтения:
 * подключённые sshd_config.d раньше основного, если Include стоит в начале.
 * @param {string[]} texts @param {string} key
 */
function sshdValue(texts, key) {
  for (const text of texts) {
    let inMatch = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [name, ...rest] = line.split(/\s+/);
      if (/^match$/i.test(name ?? '')) inMatch = true;
      if (inMatch) continue;
      if ((name ?? '').toLowerCase() === key.toLowerCase()) return rest.join(' ').toLowerCase();
    }
  }
  return null;
}

/** @param {unknown} value @returns {Record<string, any>} */
const obj = (value) => (value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {});

/**
 * @param {AuditFiles} files
 * @returns {AuditItem[]}
 */
export function auditServer(files) {
  /** @type {AuditItem[]} */
  const items = [];
  const yes = (item, note) => items.push({ item, status: 'есть', ...(note ? { note } : {}) });
  const no = (item, note) => items.push({ item, status: 'нет', note });

  const password = sshdValue(files.sshd, 'PasswordAuthentication');
  if (password === 'no') yes('SSH: вход по паролю выключен');
  else no('SSH: вход по паролю выключен', 'PasswordAuthentication не no (по умолчанию sshd разрешает пароль)');
  const root = sshdValue(files.sshd, 'PermitRootLogin');
  if (root === 'no') yes('SSH: вход root выключен');
  else no('SSH: вход root выключен', 'PermitRootLogin не no');
  const kbd = sshdValue(files.sshd, 'KbdInteractiveAuthentication') ?? sshdValue(files.sshd, 'ChallengeResponseAuthentication');
  if (kbd === 'yes') no('SSH: вход только по ключу', 'KbdInteractiveAuthentication yes открывает вход по паролю');
  else if (sshdValue(files.sshd, 'PubkeyAuthentication') === 'no') no('SSH: вход только по ключу', 'PubkeyAuthentication no');
  else yes('SSH: вход только по ключу');

  const upgrades = files.autoUpgrades ?? '';
  if (/APT::Periodic::Unattended-Upgrade\s+"1"/.test(upgrades) && /APT::Periodic::Update-Package-Lists\s+"1"/.test(upgrades)) yes('Автоматические обновления безопасности включены');
  else no('Автоматические обновления безопасности включены', 'в 20auto-upgrades нет Update-Package-Lists "1" и Unattended-Upgrade "1"');

  if (files.containers.length === 0) no('Контейнеры портала запущены', 'docker inspect не вернул ни одного контейнера');
  for (const raw of files.containers) {
    const c = obj(raw);
    const config = obj(c.Config);
    const host = obj(c.HostConfig);
    const service = String(obj(config.Labels)['com.docker.compose.service'] ?? String(c.Name ?? '').replace(/^\//, ''));
    const label = `Контейнер ${service}`;
    const ports = Object.entries(obj(host.PortBindings)).filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0).map(([port]) => port);
    const extra = ports.filter((port) => !ALLOWED_PORTS.has(port));
    if (extra.length > 0) no(`${label}: наружу только 80 и 443`, `опубликованы ${extra.join(', ')}`);
    else if (ports.length > 0) yes(`${label}: наружу только 80 и 443`);

    const image = String(config.Image ?? '');
    if (/@sha256:[0-9a-f]{64}$/.test(image)) yes(`${label}: образ по digest`);
    else no(`${label}: образ по digest`, 'образ задан тегом без @sha256');

    const exception = INFRA_EXCEPTIONS[/** @type {keyof typeof INFRA_EXCEPTIONS} */ (service)];
    const user = String(config.User ?? '');
    const rootUser = user === '' || user === 'root' || user === '0' || user.startsWith('0:') || user.startsWith('root:');
    if (PORTAL_SERVICES.includes(service)) {
      if (rootUser) no(`${label}: не от root`, 'пользователь не задан или root');
      else yes(`${label}: не от root`);
    } else if (exception && rootUser) items.push({ item: `${label}: не от root`, status: 'исключение', note: exception });
    if (READ_ONLY_SERVICES.includes(service)) {
      if (host.ReadonlyRootfs === true) yes(`${label}: файловая система только для чтения`);
      else no(`${label}: файловая система только для чтения`, 'read_only не включён');
    } else if (exception && host.ReadonlyRootfs !== true) items.push({ item: `${label}: файловая система только для чтения`, status: 'исключение', note: exception });

    // Caddy пускает только адреса Cloudflare (решение 0020): значение переменной не печатается.
    if (service === 'caddy') {
      const proxies = (Array.isArray(config.Env) ? config.Env : []).map(String).find((entry) => entry.startsWith('TRUSTED_PROXIES='));
      const value = proxies ? proxies.slice('TRUSTED_PROXIES='.length) : null;
      if (value === null) yes('Caddy: только адреса Cloudflare', 'список по умолчанию из compose.prod.yaml');
      else if (/(^|\s)(0\.0\.0\.0\/0|::\/0)(\s|$)/.test(value)) no('Caddy: только адреса Cloudflare', 'разрешены все адреса: допустимо только на staging без Cloudflare');
      else yes('Caddy: только адреса Cloudflare', 'список задан в .env');
    }
  }
  return items;
}

/** @param {AuditItem[]} items @returns {string[]} строки вывода */
export function formatAudit(items) {
  return items.map((i) => `${i.status}: ${i.item}${i.note ? ` (${i.note})` : ''}`);
}

/** @param {string} dir каталог образцов или null для настоящего сервера @returns {AuditFiles} */
function readFiles(dir) {
  const base = dir ?? '/etc';
  const sshdMain = dir ? join(dir, 'sshd_config') : '/etc/ssh/sshd_config';
  const sshdDir = dir ? join(dir, 'sshd_config.d') : '/etc/ssh/sshd_config.d';
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const included = existsSync(sshdDir) ? readdirSync(sshdDir).filter((n) => n.endsWith('.conf')).sort().map((n) => readFileSync(join(sshdDir, n), 'utf8')) : [];
  const main = read(sshdMain) ?? '';
  // Ubuntu ставит Include в начало sshd_config: подключённые файлы читаются первыми.
  const sshd = /^\s*Include\s/m.test(main) || dir ? [...included, main] : [main];
  const autoUpgrades = read(dir ? join(dir, '20auto-upgrades') : join(base, 'apt/apt.conf.d/20auto-upgrades'));
  let containers = [];
  if (dir) containers = JSON.parse(read(join(dir, 'docker-inspect.json')) ?? '[]');
  else {
    const ids = execFileSync('docker', ['ps', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    containers = ids.length > 0 ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) : [];
  }
  return { sshd, autoUpgrades, containers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--dir');
  const dir = at > 0 ? process.argv[at + 1] ?? null : null;
  const items = auditServer(readFiles(dir));
  for (const line of formatAudit(items)) console.log(line);
  const missing = items.filter((i) => i.status === 'нет').length;
  console.log(missing === 0 ? 'Итог: все пункты есть' : `Итог: пунктов "нет" ${missing}`);
  process.exit(missing === 0 ? 0 : 1);
}
