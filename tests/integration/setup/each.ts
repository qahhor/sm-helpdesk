import '@/wiring';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeEach } from 'vitest';
import { closeAuthPool } from '@/db/auth-client';
import { closeAppPool } from '@/db/client';
import { setNestedTxHookForTests } from '@/db/with-actor';
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

const siteOf = (stack: string): string => {
  const frame = stack.split('\n').find((line) => line.includes('/src/') && !line.includes('/src/db/'));
  const match = frame ? /at (?:async )?(?:(\S+) \()?.*\/(src\/[^:)]+)/.exec(frame) : null;
  return match ? `${match[2]}#${match[1] ?? ''}` : 'tests';
};
if (process.env.NESTED_TX_REPORT)
  setNestedTxHookForTests((found) => appendFileSync(process.env.NESTED_TX_REPORT!, `${found.outer}>${found.inner} ${siteOf(found.outerStack)} > ${siteOf(found.stack)}\n`));
