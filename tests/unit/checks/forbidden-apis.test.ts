import { expect, test } from 'vitest';
import { findForbiddenApis } from '../../../scripts/checks/forbidden-apis.mjs';

test.each([
  ["'use cache';\nexport async function f() {}", 'use-cache'],
  ['export async function f() {\n  "use cache: private";\n}', 'use-cache'],
  ["import { unstable_cache } from 'next/cache';", 'unstable-cache'],
  ["import { cacheLife, cacheTag } from 'next/cache';", 'cache-api'],
  ['export const revalidate = 60;', 'cache-api'],
  ["export const dynamic = 'force-static';", 'cache-api'],
  ["await fetch(url, { cache: 'force-cache' });", 'cache-api'],
  ['await fetch(url, { next: { revalidate: 30 } });', 'cache-api'],
  ['<div dangerouslySetInnerHTML={{ __html: x }} />', 'inner-html'],
  ['<div style={{ color: "red" }} />', 'inline-style'],
])('находит %s', (text, rule) => {
  expect(findForbiddenApis('src/app/x.tsx', text).map((v) => v.rule)).toEqual([rule]);
});

test('номер строки указывает на нарушение', () => {
  expect(findForbiddenApis('src/app/x.ts', "const a = 1;\n\nimport { unstable_cache } from 'next/cache';")).toEqual([
    { line: 3, rule: 'unstable-cache' },
  ]);
});

test('revalidatePath из next/cache разрешён', () => {
  expect(findForbiddenApis('src/app/x.ts', "import { revalidatePath } from 'next/cache';")).toEqual([]);
});

test('отключение кеша разрешено', () => {
  const text = "export const dynamic = 'force-dynamic';\nexport const revalidate = 0;\nawait fetch(url, { cache: 'no-store' });";
  expect(findForbiddenApis('src/app/x.ts', text)).toEqual([]);
});

test('встроенный скрипт темы в списке исключений', () => {
  expect(
    findForbiddenApis('src/ui/theme/ThemeScript.tsx', '<script dangerouslySetInnerHTML={{ __html: s }} />'),
  ).toEqual([]);
});

// Защита от SQL-инъекций (ТЗ 14.3, V2 ASVS): в базу уходят только параметры. Склейка текста запроса запрещена.
test.each([
  ['await tx.execute(sql.raw(`select * from t where id = ${id}`));', 'raw-sql'],
  ["const q = sql.raw('drop table ' + name);", 'raw-sql'],
  ['await client.query(`select * from t where name = ${name}`);', 'raw-sql'],
  ["await pool.query('select * from t where name = ' + name);", 'raw-sql'],
  ['await tx.execute(`select 1 from t where id = ${id}`);', 'raw-sql'],
  ["await db.execute('delete from t where id = ' + id);", 'raw-sql'],
])('склейку SQL находит: %s', (text, rule) => {
  expect(findForbiddenApis('src/modules/x/core/y.ts', text).map((v) => v.rule)).toEqual([rule]);
});

test('параметры SQL разрешены', () => {
  const text = [
    'await tx.execute(sql`select * from t where id = ${id}`);',
    "await client.query('select * from t where id = $1', [id]);",
    'await client.query(`select 1 from pg_roles where rolname = current_user`);',
    "tx.select().from(t).where(eq(t.id, id));",
  ].join('\n');
  expect(findForbiddenApis('src/modules/x/core/y.ts', text)).toEqual([]);
});

test('системный актор запрещён в обработчиках запросов: src/app и src/ui (аудит 23.11.2026, A7)', () => {
  const text = "const actor = { type: 'system', job: 'x' } as const;";
  expect(findForbiddenApis('src/app/api/x/route.ts', text).map((v) => v.rule)).toEqual(['system-actor']);
  expect(findForbiddenApis('src/ui/x.tsx', 'withActor({ type: "system", job: "x" }, fn)').map((v) => v.rule)).toEqual(['system-actor']);
  expect(findForbiddenApis('src/modules/hdt/core/x.ts', text)).toEqual([]);
  expect(findForbiddenApis('src/worker/main.ts', text)).toEqual([]);
});
