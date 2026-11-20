// Запуск проекта одной командой: pnpm dev:up.
// 1. Создаёт .env из .env.example со случайными паролями, если файла нет.
// 2. Поднимает PostgreSQL (docker compose) и ждёт его готовности.
// 3. Создаёт роли и базу, применяет миграции.
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

/**
 * Создаёт .env со случайными паролями, если его ещё нет. Существующий файл не трогает.
 * @returns {boolean} true, если файл создан
 */
export function ensureEnvFile() {
  if (existsSync(ENV_FILE)) return false;
  /** @type {Map<string, string>} */
  const secrets = new Map();
  // Одинаковая заглушка в .env.example получает один и тот же пароль:
  // пароль суперпользователя стоит и в адресе подключения, и в настройке контейнера.
  let text = readFileSync(resolve(root, '.env.example'), 'utf8').replace(/change-me-[a-z]+/g, (placeholder) => {
    if (!secrets.has(placeholder)) secrets.set(placeholder, randomBytes(18).toString('hex'));
    return /** @type {string} */ (secrets.get(placeholder));
  });
  // Образ и порт базы, заданные в окружении, запоминаются: их читает docker compose.
  for (const name of ['PG_IMAGE', 'PG_PORT'])
    if (process.env[name]) text += `${name}=${process.env[name]}\n`;
  if (process.env.PG_PORT) text = text.replaceAll('@127.0.0.1:5432/', `@127.0.0.1:${process.env.PG_PORT}/`);
  writeFileSync(ENV_FILE, text, { mode: 0o600 });
  return true;
}

/** Поднимает базу, создаёт роли и применяет миграции. Повторный вызов безопасен. */
export async function prepareDatabase() {
  process.loadEnvFile(ENV_FILE);
  execFileSync('docker', ['compose', 'up', '--detach', '--wait'], { cwd: root, stdio: 'inherit' });
  await bootstrap();
  const { applied } = await migrate();
  return { applied };
}

if (import.meta.main) {
  try {
    if (ensureEnvFile()) console.log('Создан файл .env со случайными паролями для разработки');
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
