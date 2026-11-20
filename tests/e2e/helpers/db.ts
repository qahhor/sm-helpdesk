import pg from 'pg';

// Запросы к базе браузерных тестов под суперпользователем: подготовка данных и проверки в обход RLS.
// Адрес берётся из .env (его загружает playwright.config.ts) или из окружения CI.

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (pool) return pool;
  const url = new URL(process.env.DATABASE_URL_SUPERUSER ?? '');
  url.pathname = `/${process.env.HUB_DB_NAME ?? 'hub'}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return pool;
}

export async function dbRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
