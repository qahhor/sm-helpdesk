import { expect, test } from 'vitest';
import { bootstrap } from '../../scripts/db/bootstrap.mjs';
import { migrate } from '../../scripts/db/migrate.mjs';
import { compareVersions, dropMigratedObjects, pools } from './helpers/db';

test('версия и расширения соответствуют разделу 9.2 ТЗ', async () => {
  const v = await pools.owner.query("select current_setting('server_version_num')::int as n");
  expect(v.rows[0].n).toBeGreaterThanOrEqual(180000);
  const ext = await pools.owner.query(
    "select extname, extversion from pg_extension where extname in ('vector', 'pg_trgm')",
  );
  expect(ext.rows.map((r) => r.extname).sort()).toEqual(['pg_trgm', 'vector']);
  expect(compareVersions(ext.rows.find((r) => r.extname === 'vector').extversion, '0.8.7')).toBeGreaterThanOrEqual(0);
});

test('ни одна из трёх ролей не суперпользователь и не обходит RLS', async () => {
  const r = await pools.owner.query(
    `select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
     from pg_roles where rolname in ('hub_owner', 'hub_app', 'hub_auth') order by rolname`,
  );
  const plain = { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false };
  expect(r.rows).toEqual([
    { rolname: 'hub_app', ...plain },
    { rolname: 'hub_auth', ...plain },
    { rolname: 'hub_owner', ...plain },
  ]);
});

test('hub_auth не читает таблицы предметной области', async () => {
  await expect(pools.auth.query('select 1 from hdr_product_modules')).rejects.toThrow(/permission denied/);
  await expect(pools.auth.query('select 1 from hdc_settings')).rejects.toThrow(/permission denied/);
});

test('hub_app не меняет схему и не видит журнал миграций', async () => {
  await expect(pools.app.query('create table x_probe (id int)')).rejects.toThrow(/permission denied/);
  await expect(pools.app.query('drop table hdc_settings')).rejects.toThrow(/must be owner/);
  await expect(pools.app.query('alter table hdc_settings disable row level security')).rejects.toThrow(/must be owner/);
  await expect(pools.app.query('select 1 from migrations.applied')).rejects.toThrow(/permission denied/);
});

test('повторный запуск начальной настройки и миграций ничего не меняет', async () => {
  await expect(bootstrap()).resolves.toBeUndefined();
  expect(await migrate()).toEqual({ applied: 0, searchIndexed: true });
  await pools.app.query('select 1');
});

test('изменённый файл применённой миграции останавливает миграции', async () => {
  await pools.owner.query("update migrations.applied set checksum = 'changed' where name like '0001_%'");
  try {
    await expect(migrate()).rejects.toThrow(/0001_.*изменён/);
  } finally {
    // База возвращается в исходное состояние: всё, что создали миграции, удаляется и создаётся заново.
    await dropMigratedObjects();
    expect((await migrate()).applied).toBeGreaterThanOrEqual(3);
  }
});

// Проверка на инъекции (волна 7, S-A2; миграция 0131): функция SECURITY DEFINER без pg_temp в конце search_path ищет
// таблицы сначала во временной схеме вызывающего. Временных таблиц роли приложения создать не могут.
test('у каждой функции SECURITY DEFINER search_path задан и оканчивается на pg_temp', async () => {
  const { rows } = await pools.root.query<{ name: string; path: string | null }>(
    `select n.nspname || '.' || p.proname as name,
            (select substring(c from 13) from unnest(p.proconfig) c where c like 'search_path=%') as path
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1`,
  );
  expect(rows.length).toBeGreaterThan(0);
  const wrong = rows.filter((row) => !row.path || !/(?:^|,\s*)pg_temp$/.test(row.path) || /(?:^|,\s*)pg_temp\s*,/.test(row.path));
  expect(wrong).toEqual([]);
});

test('hub_app и hub_auth не имеют права TEMP и не создают временных таблиц', async () => {
  const { rows } = await pools.root.query(`select r as role, has_database_privilege(r, current_database(), 'TEMP') as temp from unnest(array['hub_app', 'hub_auth', 'public']) r order by 1`);
  expect(rows).toEqual([
    { role: 'hub_app', temp: false },
    { role: 'hub_auth', temp: false },
    { role: 'public', temp: false },
  ]);
  await expect(pools.app.query('create temp table t_probe (id int)')).rejects.toThrow(/permission denied/);
  await expect(pools.auth.query('create temp table t_probe (id int)')).rejects.toThrow(/permission denied/);
});
