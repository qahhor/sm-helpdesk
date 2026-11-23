// Начальная настройка базы: три роли, база, расширения, права на схему public.
// Выполняется под суперпользователем один раз на окружение. Повторный запуск безопасен.
//
// Переменные окружения:
//   DATABASE_URL_SUPERUSER  адрес подключения суперпользователя (к любой базе сервера)
//   HUB_DB_NAME             имя базы портала, по умолчанию hub
//   HUB_OWNER_PASSWORD, HUB_APP_PASSWORD, HUB_AUTH_PASSWORD  пароли ролей.
//     Если переменная не задана, пароль берётся из DATABASE_URL_OWNER, DATABASE_URL_APP, DATABASE_URL_AUTH.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';

// hub_owner владеет таблицами и выполняет миграции. hub_app работает от имени актора,
// политики RLS для него принудительны. hub_auth видит только таблицы аутентификации (ТЗ 10.3).
const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';

/**
 * Запись пароля в формате SCRAM-SHA-256, как её хранит PostgreSQL.
 * Сервер получает готовую запись: открытый пароль не попадает в текст запроса и в журнал сервера.
 * @param {string} password
 */
function scramVerifier(password) {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (/** @type {Buffer} */ value) => value.toString('base64');
  return ['SCRAM-SHA-256', `${iterations}:${b64(salt)}`, `${b64(storedKey)}:${b64(serverKey)}`].join('$');
}

/** @param {string | undefined} url */
function passwordFromUrl(url) {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {{ superuserUrl?: string; dbName?: string; ownerPassword?: string; appPassword?: string; authPassword?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function bootstrap(opts = {}) {
  const env = process.env;
  const superuserUrl = opts.superuserUrl ?? env.DATABASE_URL_SUPERUSER;
  const dbName = opts.dbName ?? env.HUB_DB_NAME ?? 'hub';
  const passwords = {
    hub_owner: opts.ownerPassword ?? env.HUB_OWNER_PASSWORD ?? passwordFromUrl(env.DATABASE_URL_OWNER),
    hub_app: opts.appPassword ?? env.HUB_APP_PASSWORD ?? passwordFromUrl(env.DATABASE_URL_APP),
    hub_auth: opts.authPassword ?? env.HUB_AUTH_PASSWORD ?? passwordFromUrl(env.DATABASE_URL_AUTH),
  };

  const missing = [
    !superuserUrl && 'DATABASE_URL_SUPERUSER',
    !passwords.hub_owner && 'HUB_OWNER_PASSWORD или DATABASE_URL_OWNER',
    !passwords.hub_app && 'HUB_APP_PASSWORD или DATABASE_URL_APP',
    !passwords.hub_auth && 'HUB_AUTH_PASSWORD или DATABASE_URL_AUTH',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Начальная настройка базы: не заданы ${missing.join(', ')}`);
  // Имя базы подставляется в текст команды, поэтому допускаются только простые имена.
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName))
    throw new Error('HUB_DB_NAME: допускаются строчные латинские буквы, цифры и знак подчёркивания');
  if (new Set(Object.values(passwords)).size !== 3)
    throw new Error('Пароли ролей hub_owner, hub_app и hub_auth должны различаться');

  const server = new pg.Client({ connectionString: superuserUrl });
  await server.connect();
  try {
    for (const [role, password] of Object.entries(passwords)) {
      const exists = (await server.query('select 1 from pg_roles where rolname = $1', [role])).rowCount > 0;
      const action = exists ? 'ALTER' : 'CREATE';
      await server.query(`${action} ROLE ${role} ${ROLE_ATTRIBUTES} PASSWORD '${scramVerifier(password)}'`);
    }
    const dbExists = (await server.query('select 1 from pg_database where datname = $1', [dbName])).rowCount > 0;
    if (!dbExists) await server.query(`CREATE DATABASE ${dbName} OWNER hub_owner`);
    await server.query(`ALTER DATABASE ${dbName} OWNER TO hub_owner`);
    await server.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await server.query(`GRANT CONNECT ON DATABASE ${dbName} TO hub_app, hub_auth`);
  } finally {
    await server.end();
  }

  const dbUrl = new URL(superuserUrl);
  dbUrl.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  try {
    // Расширения ставит суперпользователь: так установка не зависит от списка доверенных расширений.
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    // Статистика запросов для поиска медленных мест (план W0, задача 5). Собирается, когда библиотека загружена
    // при запуске базы (shared_preload_libraries в compose.prod.yaml); без этого расширение просто не считает.
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    // Схема public закрыта для всех, кроме явно названных ролей.
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA public TO hub_app, hub_auth');
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  try {
    await bootstrap();
    console.log('Начальная настройка базы выполнена: роли hub_owner, hub_app, hub_auth, расширения vector и pg_trgm');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
