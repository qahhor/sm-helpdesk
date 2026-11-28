import type { Pool, PoolClient } from 'pg';

// Нулевой байт в параметрах запроса (волна 7, S-T; решение 0157). PostgreSQL не хранит U+0000 в тексте: параметр с
// ним даёт ошибку 22021, а в jsonb ошибку 22P05. Строка поиска или текст с таким знаком роняли запрос ошибкой базы
// вместо обычного ответа. Знак убирается из параметров на границе базы, один раз для всех входов: смысла он не несёт,
// сохранить его нельзя. Текст запроса не трогается: запросы пишет код, а не пользователь.

const NUL = /\u0000/g;

/** Значение параметра без нулевых байтов: строки, списки и простые объекты (они уходят в jsonb). */
export function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(NUL, '') : value;
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
