import 'server-only';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { stripNulFromParams } from './no-nul';
import { env } from '@/env';
import { poolMaxOf } from './pool-size';

// Подключение приложения к базе под ролью hub_app. Политики RLS для этой роли принудительны,
// поэтому запросы выполняются только через withActor (src/db/with-actor.ts).
// Этот файл импортируют только src/db и src/modules: правило линтера, ТЗ 9.4.

export type AppDb = NodePgDatabase;
export type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

// В разработке Next.js перезагружает модули, а пул соединений должен оставаться один.
const shared = globalThis as typeof globalThis & { __hubAppPool?: Pool; __hubAppDb?: AppDb };

function createAppPool(): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL_APP,
    application_name: 'hub-web',
    max: poolMaxOf(env.DB_POOL_MAX),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Обрыв сети без уведомления должен обнаруживаться, а не держать соединение вечно.
    keepAlive: true,
    // Страховка от зависших запросов и забытых транзакций: предел на стороне базы и на стороне приложения.
    statement_timeout: 30_000,
    query_timeout: 35_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // Обрыв простаивающего соединения не должен останавливать процесс.
  pool.on('error', (error) => console.error(`Соединение с базой закрыто с ошибкой: ${error.message}`));
  return stripNulFromParams(pool);
}

/** Пул соединений роли hub_app. Создаётся при первом обращении: сборке приложения база не нужна. */
export function getAppPool(): Pool {
  return (shared.__hubAppPool ??= createAppPool());
}

export function getAppDb(): AppDb {
  return (shared.__hubAppDb ??= drizzle(getAppPool()));
}

/** Закрывает пул. Нужна тестам и остановке процесса. */
export async function closeAppPool(): Promise<void> {
  const pool = shared.__hubAppPool;
  shared.__hubAppPool = undefined;
  shared.__hubAppDb = undefined;
  await pool?.end();
}

type PingCheck = (client: PoolClient) => Promise<boolean>;

const answers: PingCheck = async (client) => {
  await client.query('select 1');
  return true;
};

/**
 * Приложение подключено под ролью hub_app, и у роли нет прав, с которыми политики RLS не действуют.
 * Страховка на случай неверной настройки подключения: такой сервер не должен считаться готовым.
 */
export const isRestrictedAppRole: PingCheck = async (client) => {
  const result = await client.query(
    `select current_user = 'hub_app' and not rolsuper and not rolbypassrls as ok
     from pg_roles where rolname = current_user`,
  );
  return result.rows[0]?.ok === true;
};

/**
 * Отвечает ли база за отведённое время. Ошибку не бросает.
 * Соединение, которое не ответило вовремя, закрывается, а не остаётся занятым:
 * иначе проверки при зависшей базе по одному забрали бы весь пул.
 */
export async function pingPool(pool: Pool, timeoutMs: number, check: PingCheck = answers): Promise<boolean> {
  let client: PoolClient | undefined;
  let released = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (destroy: boolean) => {
    if (!client || released) return;
    released = true;
    client.release(destroy);
  };

  const attempt = (async () => {
    try {
      client = await pool.connect();
    } catch {
      return false;
    }
    if (timedOut) {
      release(true);
      return false;
    }
    try {
      const ok = await check(client);
      release(false);
      return ok;
    } catch {
      release(true);
      return false;
    }
  })();
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      release(true);
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Готовность базы приложения: отвечает и подключена под ограниченной ролью. */
export function pingDb(timeoutMs = 2000): Promise<boolean> {
  return pingPool(getAppPool(), timeoutMs, isRestrictedAppRole);
}
