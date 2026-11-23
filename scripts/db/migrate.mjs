// Применяет файлы миграций из каталога drizzle/ по порядку имён, затем ставит или обновляет схему pg-boss
// (scripts/db/pgboss.mjs, решение 0028). Миграции пишутся руками на SQL (ТЗ 10.3) и после применения не правятся.
// Файл выполняется одной транзакцией. Исключение: файл с первой строкой "-- hub:no-transaction" (см. ниже).
//
// Переменные окружения:
//   DATABASE_URL_OWNER  адрес подключения роли hub_owner
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { installPgBoss } from './pgboss.mjs';

// Постоянный номер блокировки: два одновременных запуска миграций выполняются по очереди.
const LOCK_KEY = 7_403_001;
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

// Файл, первая строка которого равна этой отметке, выполняется вне транзакции, по одной команде (решение 0039).
// Нужен для индексов на больших таблицах: обычный CREATE INDEX держит запись в таблицу на всё время построения,
// CREATE INDEX CONCURRENTLY нет, но внутри транзакции он не выполняется. Вне транзакции нет отката, поэтому в таком
// файле допускаются только команды, которые безопасно повторить после сбоя.
const NO_TRANSACTION = '-- hub:no-transaction';
// Таблица может быть в схеме auth (таблицы библиотеки входа): индекс живёт в схеме своей таблицы.
const CONCURRENT_CREATE = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s+ON\s+(?:([a-z_][a-z0-9_]*)\.)?/i;
const CONCURRENT_DROP = /^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+(?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)$/i;

/** @param {string} sql */
const runsOutsideTransaction = (sql) => sql.split('\n', 1)[0]?.trim() === NO_TRANSACTION;

/**
 * Команды файла без транзакции. Любая другая команда: ошибка до выполнения.
 * @param {string} name
 * @param {string} sql
 * @returns {{ text: string; index: string; schema: string; creates: boolean }[]}
 */
function concurrentStatements(name, sql) {
  const body = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const statements = body
    .split(';')
    .map((text) => text.trim().replace(/\s+/g, ' '))
    .filter((text) => text.length > 0);
  const parsed = statements.map((text) => {
    const create = CONCURRENT_CREATE.exec(text);
    const drop = create ? null : CONCURRENT_DROP.exec(text);
    const index = create?.[1] ?? drop?.[2];
    const schema = (create?.[2] ?? drop?.[1] ?? 'public').toLowerCase();
    return index ? { text, index, schema, creates: Boolean(create) } : null;
  });
  if (parsed.length === 0 || parsed.some((statement) => statement === null))
    throw new Error(
      `Миграция ${name}: вне транзакции допускаются только CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS и DROP INDEX CONCURRENTLY IF EXISTS`,
    );
  return /** @type {{ text: string; index: string; schema: string; creates: boolean }[]} */ (parsed);
}

/**
 * Выполняет файл без транзакции. Построение, оборванное сбоем, оставляет недействительный индекс с тем же именем:
 * IF NOT EXISTS его пропустил бы, поэтому такой индекс сначала удаляется.
 * @param {import('pg').Client} client
 * @param {{ text: string; index: string; schema: string; creates: boolean }[]} statements
 */
async function runOutsideTransaction(client, statements) {
  for (const statement of statements) {
    if (statement.creates) {
      const invalid = await client.query(
        `select 1 from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1 and n.nspname = $2 and not i.indisvalid`,
        [statement.index, statement.schema],
      );
      if (invalid.rowCount) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${statement.schema}.${statement.index}`);
    }
    await client.query(statement.text);
  }
}

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

    // Файлы без транзакции проверяются до первой команды: откатить их нельзя.
    /** @type {Map<string, { sql: string; statements: { text: string; index: string; schema: string; creates: boolean }[] | null }>} */
    const loaded = new Map();
    for (const name of files) {
      const sql = await readFile(resolve(dir, name), 'utf8');
      loaded.set(name, { sql, statements: !done.has(name) && runsOutsideTransaction(sql) ? concurrentStatements(name, sql) : null });
    }

    let applied = 0;
    for (const name of files) {
      const { sql, statements } = /** @type {{ sql: string; statements: { text: string; index: string; schema: string; creates: boolean }[] | null }} */ (loaded.get(name));
      const sum = checksum(sql);
      if (done.has(name)) {
        if (done.get(name) !== sum)
          throw new Error(
            `Файл миграции ${name} изменён после применения. Применённые миграции не правятся: добавьте новую.`,
          );
        continue;
      }
      if (statements) {
        // Вне транзакции: запись о применении ставится после последней команды. Сбой посреди файла оставляет его
        // не применённым, повтор доводит до конца.
        try {
          await runOutsideTransaction(client, statements);
          await client.query('insert into migrations.applied (name, checksum) values ($1, $2)', [name, sum]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Миграция ${name} не применена: ${reason}`, { cause: error });
        }
        applied += 1;
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
    // Схема очереди задач: после миграций, потому что 0012 заранее выдаёт права на её будущие объекты.
    await installPgBoss(ownerUrl);
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
