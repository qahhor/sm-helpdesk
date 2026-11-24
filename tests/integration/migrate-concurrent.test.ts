import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { migrate } from '../../scripts/db/migrate.mjs';
import { pools } from './helpers/db';

// Миграции вне транзакции для индексов на больших таблицах (план W2, задача 1; замечание F12 проверки волны 1):
// обычный CREATE INDEX держит запись в таблицу на всё время построения, CREATE INDEX CONCURRENTLY нет, но в транзакции
// он не выполняется. Файл с первой строкой "-- hub:no-transaction" выполняется по одной команде вне транзакции.

const NAMES = ['9001_w2_probe_table.sql', '9002_w2_probe_index.sql', '9003_w2_probe_bad.sql', '9004_w2_probe_fail.sql'];

/** Каталог миграций: все настоящие файлы плюс пробные. Журнал уже применённых должен сходиться. */
async function dirWith(extra: Record<string, string>): Promise<string> {
  const { cpSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'hub-migrations-'));
  cpSync('drizzle', dir, { recursive: true });
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  return dir;
}

afterEach(async () => {
  await pools.owner.query(`delete from migrations.applied where name = any($1)`, [NAMES]);
  await pools.owner.query(`drop table if exists w2_probe`);
});

const TABLE = `CREATE TABLE w2_probe (id int NOT NULL, tag text);\nINSERT INTO w2_probe SELECT g, 'x' FROM generate_series(1, 1000) g;`;
const indexes = async () =>
  (await pools.owner.query(`select indexname, i.indisvalid as valid from pg_indexes p join pg_class c on c.relname = p.indexname join pg_index i on i.indexrelid = c.oid where p.tablename = 'w2_probe' order by 1`)).rows;

test('файл с отметкой выполняется вне транзакции: CREATE INDEX CONCURRENTLY проходит', async () => {
  const dir = await dirWith({
    '9001_w2_probe_table.sql': TABLE,
    '9002_w2_probe_index.sql': `-- hub:no-transaction\n-- Индексы пробной таблицы.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i1 ON w2_probe (id);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i2 ON w2_probe (tag) WHERE tag IS NOT NULL;\n`,
  });
  expect(await migrate({ dir })).toEqual({ applied: 2 });
  expect(await indexes()).toEqual([
    { indexname: 'w2_probe_i1', valid: true },
    { indexname: 'w2_probe_i2', valid: true },
  ]);
  expect(await migrate({ dir })).toEqual({ applied: 0 });
});

test('без отметки CREATE INDEX CONCURRENTLY по-прежнему не применяется: файл идёт в транзакции', async () => {
  const dir = await dirWith({ '9001_w2_probe_table.sql': TABLE, '9002_w2_probe_index.sql': `CREATE INDEX CONCURRENTLY w2_probe_i1 ON w2_probe (id);` });
  await expect(migrate({ dir })).rejects.toThrow(/9002_w2_probe_index\.sql не применена/);
});

test('файл с отметкой принимает только построение и удаление индексов без блокировки', async () => {
  for (const sql of [
    `-- hub:no-transaction\nCREATE INDEX w2_probe_i1 ON w2_probe (id);`,
    `-- hub:no-transaction\nCREATE INDEX CONCURRENTLY w2_probe_i1 ON w2_probe (id);`,
    `-- hub:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i1 ON w2_probe (id);\nDELETE FROM w2_probe;`,
    `-- hub:no-transaction\nDROP INDEX w2_probe_i1;`,
    `-- hub:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i1 ON w2_probe (id); DROP TABLE w2_probe;`,
  ]) {
    const dir = await dirWith({ '9001_w2_probe_table.sql': TABLE, '9003_w2_probe_bad.sql': sql });
    await expect(migrate({ dir }), sql).rejects.toThrow(/9003_w2_probe_bad\.sql: вне транзакции допускаются только/);
    // Отказ до выполнения: ни одной команды файла не выполнено.
    expect(await indexes(), sql).toEqual([]);
    await pools.owner.query(`delete from migrations.applied where name = any($1)`, [NAMES]);
    await pools.owner.query(`drop table if exists w2_probe`);
  }
});

test('сбой посреди файла не отмечает его применённым, повтор доводит до конца и чинит недостроенный индекс', async () => {
  const good = `CREATE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i1 ON w2_probe (id);`;
  const broken = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS w2_probe_i2 ON w2_probe (tag);`;
  const dir = await dirWith({ '9001_w2_probe_table.sql': TABLE, '9004_w2_probe_fail.sql': `-- hub:no-transaction\n${good}\n${broken}\n` });
  // Все строки с одним значением: уникальный индекс не строится и остаётся недействительным.
  await expect(migrate({ dir })).rejects.toThrow(/9004_w2_probe_fail\.sql не применена/);
  expect((await pools.owner.query(`select 1 from migrations.applied where name = '9004_w2_probe_fail.sql'`)).rowCount).toBe(0);
  expect(await indexes()).toEqual([
    { indexname: 'w2_probe_i1', valid: true },
    { indexname: 'w2_probe_i2', valid: false },
  ]);
  // Причина устранена: повтор удаляет недействительный индекс и строит его заново.
  await pools.owner.query(`update w2_probe set tag = id::text`);
  expect(await migrate({ dir })).toEqual({ applied: 1 });
  expect(await indexes()).toEqual([
    { indexname: 'w2_probe_i1', valid: true },
    { indexname: 'w2_probe_i2', valid: true },
  ]);
});

test('имя индекса с заглавными буквами отклоняется: недостроенный индекс с таким именем остался бы незамеченным (проверка волны 2)', async () => {
  const dir = await dirWith({
    '9001_w2_probe_table.sql': TABLE,
    '9003_w2_probe_bad.sql': `-- hub:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS W2_Probe_I1 ON w2_probe (tag);`,
  });
  await expect(migrate({ dir })).rejects.toThrow(/строчными/);
  expect((await indexes()).map((row) => row.indexname)).toEqual([]);
});
