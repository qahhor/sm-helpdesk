import 'server-only';
import { z } from 'zod';

// Переменные окружения веб-приложения (ТЗ, раздел 13.5). Состав вех M0 и M1.
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

const DATABASE_URL_PARAMS = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'application_name', 'connect_timeout']);

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
    let user: string;
    try {
      user = decodeURIComponent(url.username);
    } catch {
      return fail('имя пользователя записано с ошибкой');
    }
    if (user !== role) return fail(`пользователь должен быть ${role}`);
    if (url.pathname.length <= 1) return fail('не указано имя базы');
    // Драйвер базы читает параметры адреса и ставит их выше основной части:
    // "?user=postgres" подменил бы проверенного пользователя. Разрешены только параметры из списка.
    for (const name of url.searchParams.keys())
      if (!DATABASE_URL_PARAMS.has(name)) return fail(`параметр ${name.slice(0, 32)} в адресе не допускается`);
    return value;
  });

/** Адрес отправителя писем: адрес или вид "Имя <адрес>". */
const MAIL_FROM_PATTERN = /^(?:[^<>\r\n]{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

/** Секрет подписи сессий. Короткий секрет подбирается перебором. */
const sessionSecret = required().refine((value) => value.length >= 32, { error: 'ожидается не меньше 32 знаков' });

/** Ключ AES-256: ровно 32 байта, записанные в base64. */
const encryptionKey = required().refine(
  (value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32,
  { error: 'ожидается 32 байта в base64, например вывод команды openssl rand -base64 32' },
);

/** Откуда брать адрес посетителя: заголовок, который выставляет доверенный прокси перед приложением. */
export const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: 'ожидается development, test или production',
    }),
    HUB_URL: hubUrl,
    HUB_DOMAIN: required(),
    DATABASE_URL_APP: databaseUrl('hub_app'),
    DATABASE_URL_AUTH: databaseUrl('hub_auth'),
    BETTER_AUTH_SECRET: sessionSecret,
    ENCRYPTION_KEY: encryptionKey,
    // Письма со ссылками входа: none, console и file для разработки, resend для настоящей отправки (решение 0018).
    MAIL_TRANSPORT: z.enum(['none', 'console', 'file', 'resend'], { error: 'ожидается none, console, file или resend' }).default('none'),
    MAIL_FILE_DIR: z.string().trim().min(1, { error: 'не задана' }).optional(),
    RESEND_API_KEY: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    MAIL_FROM: z
      .string()
      .trim()
      .regex(MAIL_FROM_PATTERN, { error: 'ожидается адрес или вид "Имя <адрес>"' })
      .optional(),
    // Проверка "не робот" (Cloudflare Turnstile): ключ сайта и секрет задаются парой, без них проверка выключена.
    TURNSTILE_SITE_KEY: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    TURNSTILE_SECRET: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    // Бот Telegram (решение 0018): токен и секрет вебхука задаются парой, без них бот выключен.
    TELEGRAM_BOT_TOKEN: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{32,256}$/, { error: 'ожидается от 32 до 256 знаков: латинские буквы, цифры, _ и -' })
      .optional(),
    TELEGRAM_API_URL: z.url({ error: 'ожидается адрес' }).default('https://api.telegram.org'),
    HUB_SHOWCASE: z.enum(['0', '1'], { error: 'ожидается 0 или 1' }).default('0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error'], { error: 'ожидается debug, info, warn или error' }).default('info'),
    // Заголовок, из которого берётся адрес посетителя для счётчиков частоты и журнала аудита (итоговая проверка M1).
    // За Cloudflare это cf-connecting-ip. Не задан: x-forwarded-for, только для localhost.
    CLIENT_IP_HEADER: z
      .enum(CLIENT_IP_HEADERS, { error: 'ожидается cf-connecting-ip, x-real-ip или x-forwarded-for' })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const host = new URL(value.HUB_URL).hostname;
    if (value.HUB_DOMAIN !== host)
      ctx.addIssue({ code: 'custom', path: ['HUB_DOMAIN'], message: 'не совпадает с именем узла из HUB_URL' });
    // Первое значение x-forwarded-for за Cloudflare и Caddy это адрес узла Cloudflare или значение, которое прислал
    // сам посетитель. На настоящем адресе источник адреса посетителя выбирается явно (docs/runbooks/staging-after-m1.md).
    if (value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host) && !value.CLIENT_IP_HEADER)
      ctx.addIssue({ code: 'custom', path: ['CLIENT_IP_HEADER'], message: 'не задан: за Cloudflare задайте cf-connecting-ip' });
    if (value.BETTER_AUTH_SECRET === value.ENCRYPTION_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_KEY'],
        message: 'не должен совпадать с BETTER_AUTH_SECRET',
      });
    // Ссылка для входа это секрет: в журнале и в файле на диске ей место только на машине разработчика.
    if ((value.MAIL_TRANSPORT === 'console' || value.MAIL_TRANSPORT === 'file') && !LOCAL_HOSTS.has(host))
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'значения console и file допускаются только для localhost и 127.0.0.1',
      });
    else if (value.MAIL_TRANSPORT === 'file' && !value.MAIL_FILE_DIR)
      ctx.addIssue({ code: 'custom', path: ['MAIL_FILE_DIR'], message: 'не задана, а MAIL_TRANSPORT равен file' });
    if (value.MAIL_TRANSPORT === 'resend') {
      if (!value.RESEND_API_KEY) ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'не задан, а MAIL_TRANSPORT равен resend' });
      if (!value.MAIL_FROM) ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'не задан, а MAIL_TRANSPORT равен resend' });
    }
    if (value.TELEGRAM_BOT_TOKEN && !value.TELEGRAM_WEBHOOK_SECRET)
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'не задан, а TELEGRAM_BOT_TOKEN задан: задаются парой' });
    if (value.TELEGRAM_WEBHOOK_SECRET && !value.TELEGRAM_BOT_TOKEN)
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_TOKEN'], message: 'не задан, а TELEGRAM_WEBHOOK_SECRET задан: задаются парой' });
    // Другой адрес Bot API нужен только ложному Telegram на машине разработчика: токен бота уходит туда.
    if (value.TELEGRAM_API_URL !== 'https://api.telegram.org' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_API_URL'], message: 'другой адрес допускается только для localhost и 127.0.0.1' });
    if (value.TURNSTILE_SITE_KEY && !value.TURNSTILE_SECRET)
      ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET'], message: 'не задан, а TURNSTILE_SITE_KEY задан: ключи задаются парой' });
    if (value.TURNSTILE_SECRET && !value.TURNSTILE_SITE_KEY)
      ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SITE_KEY'], message: 'не задан, а TURNSTILE_SECRET задан: ключи задаются парой' });
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
