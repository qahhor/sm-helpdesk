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
