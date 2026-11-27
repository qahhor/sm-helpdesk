import * as z from 'zod';

// Защита от загрязнения прототипа (план M9, задача 5; ASVS V15.3.6). JSON.parse делает ключи __proto__, constructor и
// prototype собственными ключами объекта; слияние такого объекта с другим или присваивание по его ключам меняет
// прототип. Здесь единственное место, где эти ключи называются: копия без них и обёртка для открытых схем Zod
// (looseObject, record, unknown и подобных) в точках входа. Закрытые схемы (object, strictObject) лишние ключи
// отбрасывают или отклоняют сами. Правило линтера запрещает литерал __proto__ и смену прототипа в остальном коде.

// eslint-disable-next-line no-restricted-syntax -- единственный перечень опасных ключей (решение 0139)
const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** Глубже копия не идёт: такой ввод не нужен ни одной форме, а рекурсия не должна ронять процесс. */
const MAX_DEPTH = 64;

/**
 * Глубокая копия обычных объектов и массивов без ключей __proto__, constructor и prototype. Даты, файлы и прочие
 * объекты не из JSON возвращаются как есть; вложенность глубже 64 уровней обрезается до undefined.
 */
export function withoutPollutionKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => withoutPollutionKeys(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) if (!POLLUTION_KEYS.has(key)) out[key] = withoutPollutionKeys((value as Record<string, unknown>)[key], depth + 1);
  return out;
}

/** Открытая схема Zod, которая получает ввод уже без опасных ключей. */
export function noProtoKeys<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => withoutPollutionKeys(value), schema);
}
