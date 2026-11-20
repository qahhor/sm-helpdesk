import { expect, test } from 'vitest';
import { bootstrap } from '../../scripts/db/bootstrap.mjs';
import { migrate } from '../../scripts/db/migrate.mjs';
import { compareVersions, pools } from './helpers/db';

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
  expect(await migrate()).toEqual({ applied: 0 });
  await pools.app.query('select 1');
});

test('изменённый файл применённой миграции останавливает миграции', async () => {
  await pools.owner.query("update migrations.applied set checksum = 'changed' where name like '0001_%'");
  try {
    await expect(migrate()).rejects.toThrow(/0001_.*изменён/);
  } finally {
    await pools.owner.query('delete from migrations.applied');
    await pools.owner.query('drop schema app cascade; drop table hdr_product_modules, hdc_settings cascade');
    expect((await migrate()).applied).toBeGreaterThanOrEqual(2);
  }
});
