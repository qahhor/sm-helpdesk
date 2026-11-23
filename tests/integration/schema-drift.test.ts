import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import * as schema from '@/db/schema';
import * as authSchema from '@/modules/hdu/auth-schema';
import { pools } from './helpers/db';

// Миграции пишутся руками (ТЗ 10.3), описания таблиц Drizzle тоже. Тест сверяет одно с другим.
const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

test('описания Drizzle есть для каждой таблицы предметной области', async () => {
  const r = await pools.owner.query("select tablename from pg_tables where schemaname = 'public' order by 1");
  expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(r.rows.map((row) => row.tablename));
});

test.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
  'колонки %s совпадают с базой: имя, порядок, тип, обязательность',
  async (name, table) => {
    const r = await pools.owner.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      [name],
    );
    const declared = getTableConfig(table).columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      not_null: column.notNull,
    }));
    expect(declared).toEqual(r.rows);
  },
);

// Таблицы библиотеки входа описаны в модуле hdu для его собственных запросов.
const authTables = Object.values(authSchema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

test.each(authTables.map((t) => [getTableConfig(t).name, t] as const))(
  'колонки auth.%s совпадают с базой: имя, порядок, тип, обязательность',
  async (name, table) => {
    expect(getTableConfig(table).schema).toBe('auth');
    const r = await pools.owner.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'auth' and c.relname = $1 and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      [name],
    );
    const declared = getTableConfig(table).columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      not_null: column.notNull,
    }));
    expect(declared).toEqual(r.rows);
  },
);

test('начальная настройка базы ставит расширение статистики запросов (план W0, задача 5)', async () => {
  const { pools } = await import('./helpers/db');
  expect((await pools.root.query(`select extname from pg_extension where extname = 'pg_stat_statements'`)).rows).toEqual([{ extname: 'pg_stat_statements' }]);
});
