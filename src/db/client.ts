import 'server-only';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@/env';

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
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Страховка от зависших запросов и забытых транзакций.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // Обрыв простаивающего соединения не должен останавливать процесс.
  pool.on('error', (error) => console.error(`Соединение с базой закрыто с ошибкой: ${error.message}`));
  return pool;
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

/** Отвечает ли база за отведённое время. Ошибку не бросает. */
export async function pingPool(pool: Pool, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const query = pool.query('select 1').then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function pingDb(timeoutMs = 2000): Promise<boolean> {
  return pingPool(getAppPool(), timeoutMs);
}
