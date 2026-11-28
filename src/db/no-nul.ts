import 'server-only';
import type { Pool, PoolClient } from 'pg';

// Нулевой байт в параметрах запроса (волна 7, S-T; решение 0157). PostgreSQL не хранит U+0000 в тексте: параметр с
// ним даёт ошибку 22021, а в jsonb ошибку 22P05. Строка поиска или текст с таким знаком роняли запрос ошибкой базы
// вместо обычного ответа. Знак убирается из параметров на границе базы, один раз для всех входов: смысла он не несёт,
// сохранить его нельзя. Текст запроса не трогается: запросы пишет код, а не пользователь.
//
// Значение колонки jsonb drizzle отдаёт уже строкой JSON: знак в ней записан шестью знаками \u0000, и база отвечает
// 22P05 (независимая проверка волны 7, R8; решение 0192). Тип параметра на этой границе неизвестен, поэтому запись
// убирается только из строки, которая разбирается как JSON, и только там, где это запись знака, а не текст после
// обратной косой черты (`\\u0000` в JSON - шесть обычных знаков, база их хранит).

const NUL = /\u0000/g;
const ESCAPED = String.raw`\u0000`;
/** Запись \u0000 в JSON: перед ней чётное число обратных косых черт (пары - это сами косые черты текста). */
const JSON_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g;

function isJson(value: string): boolean {
  const first = value.trimStart().charAt(0);
  if (first !== '{' && first !== '[' && first !== '"') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function cleanString(value: string): string {
  const text = value.includes('\u0000') ? value.replace(NUL, '') : value;
  return text.includes(ESCAPED) && isJson(text) ? text.replace(JSON_NUL, '$1') : text;
}

/** Значение параметра без нулевых байтов: строки, списки и простые объекты (они уходят в jsonb). */
export function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.some(needsCleaning) ? value.map(withoutNul) : value;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    return entries.some(([, item]) => needsCleaning(item)) ? Object.fromEntries(entries.map(([key, item]) => [key, withoutNul(item)])) : value;
  }
  return value;
}

function needsCleaning(value: unknown): boolean {
  return withoutNul(value) !== value;
}

type QueryArgs = [config: unknown, values?: unknown, ...rest: unknown[]];

function cleanArgs(args: QueryArgs): QueryArgs {
  const [config, values, ...rest] = args;
  const cleanConfig =
    config !== null && typeof config === 'object' && Array.isArray((config as { values?: unknown }).values)
      ? Object.assign(config, { values: withoutNul((config as { values: unknown[] }).values) })
      : config;
  return [cleanConfig, Array.isArray(values) ? withoutNul(values) : values, ...rest];
}

/** Каждое соединение пула убирает нулевые байты из параметров до отправки запроса. */
export function stripNulFromParams(pool: Pool): Pool {
  pool.on('connect', (client: PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: QueryArgs) => unknown }).query = (...args: QueryArgs) => query(...cleanArgs(args));
  });
  return pool;
}
