// Запуск проекта одной командой: pnpm dev:up.
// 1. Создаёт .env из .env.example со случайными паролями. В существующий файл дописывает недостающие переменные.
// 2. Поднимает PostgreSQL (docker compose) и ждёт его готовности.
// 3. Создаёт роли и базу, применяет миграции, записывает ложные серверы Smartup для входа (только на localhost).
// 4. Запускает приложение для разработки.
//
// С ключом --prepare выполняются только шаги 1-3: так базу готовят браузерные тесты.
// С ключом --env-only выполняется только шаг 1.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrap } from './db/bootstrap.mjs';
import { migrate } from './db/migrate.mjs';

const root = resolve(import.meta.dirname, '..');
const ENV_FILE = resolve(root, '.env');

// Секреты, которым мало случайной строки из букв и цифр.
/** @type {Record<string, () => string>} */
const GENERATORS = {
  // Ключ AES-256: ровно 32 байта в base64.
  ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
};

const PLACEHOLDER = /change-me-[a-z]+/g;
const escapeRegExp = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Строки вида ИМЯ=значение, без комментариев. @param {string} text */
function entries(text) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) found.set(/** @type {string} */ (match[1]), /** @type {string} */ (match[2]));
  }
  return found;
}

/**
 * Готовит файл окружения для разработки.
 * Файла нет: создаёт его из .env.example со случайными секретами.
 * Файл есть: дописывает переменные, которых в нём не хватает (их приносят новые вехи), заданные не трогает.
 * @param {{ envFile?: string; exampleFile?: string }} [opts]
 * @returns {boolean} true, если файл создан или дополнен
 */
export function ensureEnvFile(opts = {}) {
  const envFile = opts.envFile ?? ENV_FILE;
  const example = readFileSync(opts.exampleFile ?? resolve(root, '.env.example'), 'utf8');
  /** @type {Map<string, string>} */
  const secrets = new Map();
  // Одинаковая заглушка в .env.example получает один и тот же пароль:
  // пароль суперпользователя стоит и в адресе подключения, и в настройке контейнера.
  const fill = (/** @type {string} */ name, /** @type {string} */ value) =>
    GENERATORS[name] && /change-me-[a-z]+/.test(value)
      ? GENERATORS[name]()
      : value.replace(PLACEHOLDER, (placeholder) => {
          if (!secrets.has(placeholder)) secrets.set(placeholder, randomBytes(18).toString('hex'));
          return /** @type {string} */ (secrets.get(placeholder));
        });

  if (!existsSync(envFile)) {
    let text = example
      .split('\n')
      .map((line) => {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        return match ? `${match[1]}=${fill(/** @type {string} */ (match[1]), /** @type {string} */ (match[2]))}` : line;
      })
      .join('\n');
    // Образ и порт базы, заданные в окружении, запоминаются: их читает docker compose.
    for (const name of ['PG_IMAGE', 'PG_PORT']) if (process.env[name]) text += `${name}=${process.env[name]}\n`;
    if (process.env.PG_PORT) text = text.replaceAll('@127.0.0.1:5432/', `@127.0.0.1:${process.env.PG_PORT}/`);
    writeFileSync(envFile, text, { mode: 0o600 });
    return true;
  }

  const current = readFileSync(envFile, 'utf8');
  const have = entries(current);
  const wanted = entries(example);
  // Секрет, который уже задан в файле, берётся оттуда: новая строка с той же заглушкой должна с ним совпасть.
  for (const [name, template] of wanted) {
    const value = have.get(name);
    const placeholders = template.match(PLACEHOLDER);
    if (value === undefined || !placeholders || placeholders.length !== 1) continue;
    const [before, after] = template.split(/** @type {string} */ (placeholders[0]));
    const match = new RegExp(`^${escapeRegExp(before ?? '')}(.+)${escapeRegExp(after ?? '')}$`).exec(value);
    if (match) secrets.set(/** @type {string} */ (placeholders[0]), /** @type {string} */ (match[1]));
  }
  const missing = [...wanted].filter(([name]) => !have.has(name));
  if (missing.length === 0) return false;
  const added = missing.map(([name, value]) => `${name}=${fill(name, value)}`).join('\n');
  writeFileSync(envFile, `${current.replace(/\n*$/, '\n')}\n# Добавлено командой pnpm dev:up\n${added}\n`, { mode: 0o600 });
  return true;
}

/**
 * Записывает ложные серверы Smartup (scripts/mock-oidc.mjs) в реестр портала командой hub,
 * как это делает администратор с настоящим сервером. Только когда портал работает на localhost.
 */
export function registerMockServers() {
  const host = new URL(process.env.HUB_URL ?? 'http://localhost').hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  execFileSync(process.execPath, [resolve(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'ignore' });
  const servers = [
    ['mock', 'Ложный сервер (облако)', 'http://localhost:3190', ['--default', '--role-map', '{"director":"client_admin"}']],
    ['mock-dedicated', 'Ложный сервер (выделенный)', 'http://localhost:3191', []],
  ];
  for (const [code, name, url, extra] of servers)
    execFileSync(
      process.execPath,
      [resolve(root, 'dist/hub.mjs'), 'server:add', '--code', code, '--name', name, '--base-url', url, '--issuer', url, '--client-id', 'hub', ...extra],
      { cwd: root, stdio: 'ignore', env: { ...process.env, HUB_OAUTH_CLIENT_SECRET: 'mock-client-secret' } },
    );
  return true;
}

/** Поднимает базу, создаёт роли, применяет миграции и записывает ложные серверы Smartup. Повторный вызов безопасен. */
export async function prepareDatabase() {
  process.loadEnvFile(ENV_FILE);
  execFileSync('docker', ['compose', 'up', '--detach', '--wait'], { cwd: root, stdio: 'inherit' });
  await bootstrap();
  const { applied } = await migrate();
  registerMockServers();
  return { applied };
}

if (import.meta.main) {
  try {
    if (ensureEnvFile()) console.log('Файл .env готов: недостающие переменные получили случайные значения для разработки');
    if (process.argv.includes('--env-only')) process.exit(0);
    const { applied } = await prepareDatabase();
    console.log(applied > 0 ? `База готова, применено миграций: ${applied}` : 'База готова, новых миграций нет');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (process.argv.includes('--prepare')) process.exit(0);
  const dev = spawn(process.execPath, [resolve(root, 'scripts/next.mjs'), 'dev'], { cwd: root, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => dev.kill(signal));
  dev.on('exit', (code) => process.exit(code ?? 0));
}
