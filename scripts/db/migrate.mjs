// Применяет файлы миграций из каталога drizzle/ по порядку имён.
// Миграции пишутся руками на SQL (ТЗ 10.3) и после применения не правятся.
//
// Переменные окружения:
//   DATABASE_URL_OWNER  адрес подключения роли hub_owner
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

// Постоянный номер блокировки: два одновременных запуска миграций выполняются по очереди.
const LOCK_KEY = 7_403_001;
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/** @param {string} text */
const checksum = (text) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

/**
 * @param {{ ownerUrl?: string; dir?: string }} [opts]
 * @returns {Promise<{ applied: number }>}
 */
export async function migrate(opts = {}) {
  const ownerUrl = opts.ownerUrl ?? process.env.DATABASE_URL_OWNER;
  if (!ownerUrl) throw new Error('Миграции: не задана переменная DATABASE_URL_OWNER');
  const dir = opts.dir ?? resolve(import.meta.dirname, '../../drizzle');
  const found = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  // Файл с неверным именем не должен молча остаться неприменённым.
  const misnamed = found.filter((name) => !FILE_NAME.test(name));
  if (misnamed.length > 0)
    throw new Error(`Имя файла миграции не по правилу NNNN_имя.sql (строчные буквы, цифры, подчёркивание): ${misnamed.join(', ')}`);
  const files = found;

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Таблицы должны принадлежать hub_owner: у суперпользователя политики RLS не действуют.
    const who = await client.query('select current_user as name');
    if (who.rows[0].name !== 'hub_owner') throw new Error('Миграции выполняет только роль hub_owner');

    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    // Журнал миграций лежит в своей схеме: роли hub_app и hub_auth его не видят.
    await client.query('CREATE SCHEMA IF NOT EXISTS migrations');
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations.applied (
        name       text        NOT NULL,
        checksum   text        NOT NULL,
        applied_on timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT applied_pk PRIMARY KEY (name)
      )`);

    const journal = await client.query('select name, checksum from migrations.applied');
    const done = new Map(journal.rows.map((row) => [row.name, row.checksum]));
    for (const name of done.keys())
      if (!files.includes(name)) throw new Error(`Миграция ${name} применена к базе, но файла в каталоге нет`);

    let applied = 0;
    for (const name of files) {
      const sql = await readFile(resolve(dir, name), 'utf8');
      const sum = checksum(sql);
      if (done.has(name)) {
        if (done.get(name) !== sum)
          throw new Error(
            `Файл миграции ${name} изменён после применения. Применённые миграции не правятся: добавьте новую.`,
          );
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into migrations.applied (name, checksum) values ($1, $2)', [name, sum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Миграция ${name} не применена: ${reason}`, { cause: error });
      }
      applied += 1;
    }
    return { applied };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (import.meta.main) {
  try {
    const { applied } = await migrate();
    console.log(applied > 0 ? `Применено миграций: ${applied}` : 'База актуальна, новых миграций нет');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
