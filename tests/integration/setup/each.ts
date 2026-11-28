import '@/wiring';
import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { closeAuthPool } from '@/db/auth-client';
import { closeAppPool } from '@/db/client';
import { pools } from '../helpers/db';
import { nestedSite, setBaseNestedHook } from '../helpers/tx';
import { NESTED_TX_ALLOWED } from './nested-tx-allowed';

// Перед каждым тестом таблицы предметной области очищаются под ролью владельца.
beforeEach(async () => {
  // Таблицы библиотеки входа лежат в схеме auth и очищаются вместе с остальными.
  const tables = await pools.owner.query(
    "select schemaname, tablename from pg_tables where schemaname in ('public', 'auth')",
  );
  if (tables.rows.length === 0) return;
  const names = tables.rows.map((row) => `"${row.schemaname}"."${row.tablename}"`).join(', ');
  await pools.owner.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  // Задачи pg-boss прошлого теста (проверка качества, Q22): тест с настоящей очередью не должен получить чужую задачу.
  // Схема pgboss вне списка выше: её таблицы создаёт скрипт миграций, очищаются только задачи.
  await pools.root.query(`delete from pgboss.job`);
});

afterAll(async () => {
  await closeAppPool();
  await closeAuthPool();
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
});

// Транзакция внутри транзакции (проверка качества, Q12): обратный вызов withActor позвал функцию, которая сама
// открывает транзакцию. Каждый тест собирает такие места; место, которого нет в списке известных, роняет тест.
// NESTED_TX_REPORT=файл: вместо падения места пишутся в файл (так собирается список после большой переделки).
const nestedSites = new Set<string>();
beforeEach(() => {
  nestedSites.clear();
  setBaseNestedHook((found) => nestedSites.add(nestedSite(found)));
});
afterEach(() => {
  setBaseNestedHook(null);
  const fresh = [...nestedSites].filter((site) => !NESTED_TX_ALLOWED.has(site)).sort();
  if (process.env.NESTED_TX_REPORT) {
    if (nestedSites.size > 0) appendFileSync(process.env.NESTED_TX_REPORT, `${[...nestedSites].join('\n')}\n`);
    return;
  }
  expect(fresh, 'транзакция открыта внутри другой транзакции: вынесите чтение до withActor (tests/integration/setup/nested-tx-allowed.ts)').toEqual([]);
});
