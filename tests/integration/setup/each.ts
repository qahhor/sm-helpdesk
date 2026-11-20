import { afterAll, beforeEach } from 'vitest';
import { closeAppPool } from '@/db/client';
import { pools } from '../helpers/db';

// Перед каждым тестом таблицы предметной области очищаются под ролью владельца.
beforeEach(async () => {
  const tables = await pools.owner.query("select tablename from pg_tables where schemaname = 'public'");
  if (tables.rows.length === 0) return;
  const names = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pools.owner.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await closeAppPool();
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
});
