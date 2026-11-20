import { afterAll, beforeEach } from 'vitest';
import { closeAuthPool } from '@/db/auth-client';
import { closeAppPool } from '@/db/client';
import { pools } from '../helpers/db';

// Перед каждым тестом таблицы предметной области очищаются под ролью владельца.
beforeEach(async () => {
  // Таблицы библиотеки входа лежат в схеме auth и очищаются вместе с остальными.
  const tables = await pools.owner.query(
    "select schemaname, tablename from pg_tables where schemaname in ('public', 'auth')",
  );
  if (tables.rows.length === 0) return;
  const names = tables.rows.map((row) => `"${row.schemaname}"."${row.tablename}"`).join(', ');
  await pools.owner.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await closeAppPool();
  await closeAuthPool();
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
});
