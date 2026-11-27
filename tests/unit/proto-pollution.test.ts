import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import * as z from 'zod';
import { noProtoKeys, withoutPollutionKeys } from '@/lib/no-proto';

// Защита от загрязнения прототипа (план M9, задача 5; ASVS V15.3.6). Ввод точек входа приходит JSON-ом, где ключи
// __proto__, constructor и prototype становятся собственными ключами объекта. Схема точки входа либо отклоняет такой
// ввод, либо возвращает объект без этих ключей на любом уровне, и Object.prototype не меняется. Закрытые схемы Zod
// (object, strictObject и составные из них) так устроены сами; открытые (looseObject, record, passthrough, catchall,
// unknown, any, json) в файлах точек входа стоят только внутри noProtoKeys. Обход файлов падает, если точка входа
// лежит там, где он её не видит.

const ROOT = join(import.meta.dirname, '../..');
const DANGEROUS = ['__proto__', 'constructor', 'prototype'];

/** Ввод с опасными ключами на верхнем и вложенном уровне, как его даёт JSON.parse. */
const polluted = () =>
  JSON.parse('{"a":"1","kind":"x","items":[{"__proto__":{"evil":1},"b":"2"}],"nested":{"constructor":{"prototype":{"evil":1}},"c":"3"},"__proto__":{"evil":1},"constructor":{"prototype":{"evil":1}},"prototype":{"evil":1}}');

afterEach(() => {
  expect(({} as Record<string, unknown>).evil).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty('evil');
});

/** Нарушения в результате разбора: опасный собственный ключ или подменённый прототип объекта. */
function problems(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => problems(item, `${path}[${i}]`));
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  const proto = Object.getPrototypeOf(value);
  const out = proto === Object.prototype || proto === null ? [] : [`${path}: прототип подменён`];
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS.includes(key)) out.push(`${path}.${key}`);
    else out.push(...problems((value as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return out;
}

const SCHEMAS: Record<string, z.ZodType> = {
  object: z.object({ a: z.string(), nested: z.object({ c: z.string() }).optional() }),
  strictObject: z.strictObject({ a: z.string() }),
  discriminatedUnion: z.discriminatedUnion('kind', [z.object({ kind: z.literal('x'), a: z.string() }), z.object({ kind: z.literal('y') })]),
  union: z.union([z.object({ a: z.string() }), z.string()]),
  arrayOfObjects: z.object({ items: z.array(z.object({ b: z.string() })) }),
  partialRecord: z.partialRecord(z.enum(['a', 'kind']), z.string()),
  'noProtoKeys(looseObject)': noProtoKeys(z.looseObject({ a: z.string() })),
  'noProtoKeys(record)': noProtoKeys(z.record(z.string(), z.unknown())),
  'noProtoKeys(passthrough)': noProtoKeys(z.object({ a: z.string() }).passthrough()),
  'noProtoKeys(unknown)': noProtoKeys(z.unknown()),
  'object с noProtoKeys(unknown) внутри': z.object({ nested: noProtoKeys(z.unknown()), items: noProtoKeys(z.unknown()) }),
};

for (const [name, schema] of Object.entries(SCHEMAS))
  test(`схема ${name}: опасные ключи отклонены или отброшены, прототип не тронут`, () => {
    const result = schema.safeParse(polluted());
    if (result.success) expect(problems(result.data)).toEqual([]);
  });

test('открытые схемы без noProtoKeys оставляют опасные ключи: поэтому их и запрещает обход', () => {
  expect(problems(z.unknown().parse(polluted())).length).toBeGreaterThan(0);
  expect(problems(z.looseObject({ a: z.string() }).parse(polluted())).length).toBeGreaterThan(0);
});

test('withoutPollutionKeys: глубокая копия без опасных ключей, даты и примитивы как есть', () => {
  const date = new Date(0);
  const clean = withoutPollutionKeys({ ...polluted(), when: date, n: 1 }) as Record<string, unknown>;
  expect(problems(clean)).toEqual([]);
  expect(clean.when).toBe(date);
  expect(clean.n).toBe(1);
  expect(clean.items).toEqual([{ b: '2' }]);
  expect(withoutPollutionKeys('текст')).toBe('текст');
  // Слишком глубокая вложенность обрезается, а не роняет процесс.
  let deep: unknown = 'дно';
  for (let i = 0; i < 500; i++) deep = { d: deep };
  expect(() => withoutPollutionKeys(deep)).not.toThrow();
});

// --- Обход файлов точек входа ---

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return out;
}

const SOURCES = walk(join(ROOT, 'src'));
/** Точки входа: слой api модулей, действия форм, обработчики адресов, сервер MCP, разбор входящих вебхуков. */
const ENTRY = [
  /^src\/modules\/[a-z]+\/api(\.ts|\/.+\.ts)$/,
  /^src\/.+actions\.ts$/,
  /^src\/app\/.+\/route\.ts$/,
  /^src\/modules\/hda\/agent\/.+\.ts$/,
  /^src\/modules\/hdn\/provider\.ts$/,
  /^src\/security\/csp-report\.ts$/,
];
const isEntry = (path: string) => ENTRY.some((pattern) => pattern.test(path));
const OPEN = /z\.(looseObject|record|unknown|any|json)\(|\.(passthrough|catchall)\(/;

test('обход видит каждую точку входа: действия форм и обработчики адресов лежат там, где он ищет', () => {
  const missed = SOURCES.filter((path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const serverActions = /^\s*['"]use server['"]/m.test(text);
    const handlers = /export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/.test(text);
    return (serverActions || handlers) && !isEntry(path);
  });
  expect(missed).toEqual([]);
  expect(SOURCES.filter(isEntry).length).toBeGreaterThan(150);
});

test('в точках входа открытые схемы Zod стоят только внутри noProtoKeys', () => {
  const found: string[] = [];
  for (const path of SOURCES.filter(isEntry))
    readFileSync(join(ROOT, path), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (OPEN.test(line) && !line.includes('noProtoKeys(')) found.push(`${path}:${i + 1}`);
      });
  expect(found).toEqual([]);
});
