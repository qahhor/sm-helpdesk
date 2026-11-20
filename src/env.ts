import 'server-only';
import { z } from 'zod';

// Переменные окружения веб-приложения (ТЗ, раздел 13.5). Состав вехи M0.
// Остальные переменные добавляются в своих вехах. Адреса базы для владельца схемы
// и суперпользователя сюда не входят: их читают только сценарии из scripts/db/.
//
// Значения переменных в сообщения об ошибках не попадают: в адресах базы лежат пароли.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function toUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const required = () => z.string({ error: 'не задана' }).trim().min(1, { error: 'не задана' });

const hubUrl = required().transform((value, ctx) => {
  const url = toUrl(value);
  const fail = (message: string) => {
    ctx.issues.push({ code: 'custom', message, input: '' });
    return z.NEVER;
  };
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:'))
    return fail('ожидается адрес со схемой, например https://hub.smartup24.com');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname))
    return fail('http допускается только для localhost и 127.0.0.1');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '')
    return fail('ожидается только схема, узел и порт, без пути и параметров');
  return url.origin;
});

const databaseUrl = (role: 'hub_app' | 'hub_auth') =>
  required().transform((value, ctx) => {
    const url = toUrl(value);
    const fail = (message: string) => {
      ctx.issues.push({ code: 'custom', message, input: '' });
      return z.NEVER;
    };
    if (!url || (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:'))
      return fail('ожидается адрес PostgreSQL вида postgres://пользователь:пароль@узел:порт/база');
    if (decodeURIComponent(url.username) !== role) return fail(`пользователь должен быть ${role}`);
    return value;
  });

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: 'ожидается development, test или production',
    }),
    HUB_URL: hubUrl,
    HUB_DOMAIN: required(),
    DATABASE_URL_APP: databaseUrl('hub_app'),
    DATABASE_URL_AUTH: databaseUrl('hub_auth'),
    HUB_SHOWCASE: z.enum(['0', '1'], { error: 'ожидается 0 или 1' }).default('0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error'], { error: 'ожидается debug, info, warn или error' }).default('info'),
  })
  .superRefine((value, ctx) => {
    const host = new URL(value.HUB_URL).hostname;
    if (value.HUB_DOMAIN !== host)
      ctx.addIssue({ code: 'custom', path: ['HUB_DOMAIN'], message: 'не совпадает с именем узла из HUB_URL' });
    if (value.HUB_SHOWCASE === '1' && value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({
        code: 'custom',
        path: ['HUB_SHOWCASE'],
        message: 'витрина компонентов не включается в production',
      });
  });

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {
  readonly problems: readonly { name: string; reason: string }[];

  constructor(problems: readonly { name: string; reason: string }[]) {
    super(`Неверные переменные окружения: ${problems.map((p) => `${p.name} (${p.reason})`).join(', ')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((issue) => ({ name: String(issue.path[0] ?? 'окружение'), reason: issue.message })),
  );
}

let cached: Env | undefined;

/** Разбирает `process.env` при первом обращении и запоминает результат. */
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

/**
 * Проверенное окружение. Разбор откладывается до первого чтения свойства, чтобы сборка
 * (`next build`) не требовала секретов. При запуске сервера окружение проверяет
 * `src/instrumentation.ts`: с неверными переменными сервер не стартует.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_target, key) => getEnv()[key as keyof Env],
  has: (_target, key) => key in getEnv(),
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(getEnv(), key),
});
