import 'server-only';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { stripNulFromParams } from './no-nul';
import { env } from '@/env';
import type { AppDb } from './client';
import { poolMaxOf } from './pool-size';

// Подключение к базе под ролью hub_auth: таблицы библиотеки входа (схема auth) и таблицы идентичности hdu_*.
// Этим подключением пользуются только библиотека входа и модуль hdu (правило линтера, ТЗ 10.3).
// Свои запросы модуль выполняет через withIdentity (src/db/with-identity.ts).

// В разработке Next.js перезагружает модули, а пул соединений должен оставаться один.
const shared = globalThis as typeof globalThis & { __hubAuthPool?: Pool; __hubAuthDb?: AppDb };

function createAuthPool(): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL_AUTH,
    application_name: 'hub-auth',
    max: poolMaxOf(env.DB_POOL_MAX),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    // Те же пределы, что у пула приложения: зависший запрос не держит соединение вечно.
    statement_timeout: 30_000,
    query_timeout: 35_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', (error) => console.error(`Соединение аутентификации с базой закрыто с ошибкой: ${error.message}`));
  return stripNulFromParams(pool);
}

/** Пул соединений роли hub_auth. Создаётся при первом обращении: сборке приложения база не нужна. */
export function getAuthPool(): Pool {
  return (shared.__hubAuthPool ??= createAuthPool());
}

export function getAuthDb(): AppDb {
  return (shared.__hubAuthDb ??= drizzle(getAuthPool()));
}

/** Закрывает пул. Нужна тестам и остановке процесса. */
export async function closeAuthPool(): Promise<void> {
  const pool = shared.__hubAuthPool;
  shared.__hubAuthPool = undefined;
  shared.__hubAuthDb = undefined;
  await pool?.end();
}

/**
 * Подключение идёт под ролью hub_auth, и у роли нет прав, с которыми политики RLS не действуют.
 * Страховка от неверной настройки подключения, как isRestrictedAppRole у пула приложения.
 */
export async function isRestrictedAuthRole(client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `select current_user = 'hub_auth' and not rolsuper and not rolbypassrls as ok
     from pg_roles where rolname = current_user`,
  );
  return result.rows[0]?.ok === true;
}
