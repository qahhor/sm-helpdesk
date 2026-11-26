import 'server-only';
import { z } from 'zod';

// Переменные окружения веб-приложения (ТЗ, раздел 13.5). Состав вех M0, M1 и M2.
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

// Одна схема для поля CLIENT_IP_HEADER: её берут и окружение целиком, и чтение заголовка в счётчиках.
const clientIpHeaderField = z.enum(CLIENT_IP_HEADERS, { error: 'ожидается cf-connecting-ip, x-real-ip или x-forwarded-for' }).optional();

/**
 * Заголовок адреса посетителя той же схемой, что и окружение (проверка main, Q20). Не задан: x-forwarded-for.
 * Отдельно от getEnv: счётчики и журнал не должны требовать всего окружения (команда консоли, тесты).
 */
export function clientIpHeaderOf(source: Record<string, string | undefined>): ClientIpHeader {
  const parsed = clientIpHeaderField.safeParse(source.CLIENT_IP_HEADER);
  if (!parsed.success) throw new EnvError([{ name: 'CLIENT_IP_HEADER', reason: parsed.error.issues[0]?.message ?? 'неверное значение' }]);
  return parsed.data ?? 'x-forwarded-for';
}

/** Адрес S3 хранилища R2: только https, узел и порт (адрес попадает в политику CSP). */
const httpsOrigin = required().refine(
  (value) => {
    const url = toUrl(value);
    return url !== null && url.protocol === 'https:' && url.origin === value;
  },
  { error: 'ожидается адрес вида https://<счёт>.r2.cloudflarestorage.com без пути' },
);

/**
 * Внутренний адрес службы (TEI, план M5, решение 6; Typesense, план W6, решение 15): вызывается мимо защиты исходящих
 * запросов, а в запросе текст клиента. Имя службы compose без точек, localhost или частный IPv4; без учётной записи,
 * пути и параметров.
 */
const internalUrl = (example: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => {
        const url = toUrl(value);
        if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return false;
        if (url.pathname !== '/' && url.pathname !== '') return false;
        const host = url.hostname;
        if (LOCAL_HOSTS.has(host) || /^[a-z0-9][a-z0-9-]{0,62}$/i.test(host)) return true;
        const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
        if (!ip) return false;
        const [a, b] = [Number(ip[1]), Number(ip[2])];
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      },
      { error: `ожидается внутренний адрес вида ${example}: имя службы, localhost или частный IPv4, без пути` },
    );

const embeddingsUrl = internalUrl('http://tei:80');

/** Ключ Typesense: печатные знаки ASCII без пробелов (уходит заголовком X-TYPESENSE-API-KEY). */
const typesenseKey = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{16,256}$/, { error: 'ожидается ключ: от 16 до 256 печатных знаков без пробелов' });

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
    // Прежний ключ шифрования на время замены ключа (аудит 23.11.2026, находка S6): им открываются значения,
    // зашифрованные до замены. После команды hub secrets:reseal переменную убирают.
    ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .trim()
      .refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32, { error: 'ожидается 32 байта в base64' })
      .optional(),
    // Секрет подписи токена виджета (ТЗ 13.5, 11.4; план M6, решение 16). Без него виджет не работает; на настоящем
    // адресе в production обязателен.
    EMBED_TOKEN_SECRET: z.string().trim().min(32, { error: 'ожидается не меньше 32 знаков' }).optional(),
    // Письма со ссылками входа: none, console и file для разработки, resend для настоящей отправки (решение 0018).
    MAIL_TRANSPORT: z.enum(['none', 'console', 'file', 'resend'], { error: 'ожидается none, console, file или resend' }).default('none'),
    MAIL_FILE_DIR: z.string().trim().min(1, { error: 'не задана' }).optional(),
    RESEND_API_KEY: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    MAIL_FROM: z
      .string()
      .trim()
      .regex(MAIL_FROM_PATTERN, { error: 'ожидается адрес или вид "Имя <адрес>"' })
      .optional(),
    // Вебхук Resend (решение 10 вехи M4): подпись по схеме Svix, секрет вида whsec_<base64>.
    RESEND_WEBHOOK_SECRET: z
      .string()
      .trim()
      .regex(/^whsec_[A-Za-z0-9+/]{16,}={0,2}$/, { error: 'ожидается секрет вида whsec_<base64> из настроек вебхука Resend' })
      .optional(),
    // Узлы, с которых портал скачивает вложения входящих писем (аудит 23.11.2026, находка S15): через запятую,
    // сам узел или его поддомен. Не задано: только узел почтового сервиса (resend.com).
    INBOUND_DOWNLOAD_HOSTS: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+(\s*,\s*[a-z0-9-]+(\.[a-z0-9-]+)+)*$/, { error: 'ожидаются имена узлов через запятую, например resend.com' })
      .optional(),
    // Приём ответов на письма (раздел 11.8): домен адресов reply+...@домен и секрет их подписи. Без домена приём выключен.
    REPLY_DOMAIN: z
      .string()
      .trim()
      .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, { error: 'ожидается домен строчными буквами без схемы, например reply.smartup24.com' })
      .optional(),
    REPLY_HMAC_SECRET: z.string().trim().min(32, { error: 'ожидается не меньше 32 знаков' }).optional(),
    // Прежний ключ подписи адресов ответа на время замены: ответы на уже отправленные письма продолжают приниматься.
    REPLY_HMAC_SECRET_PREVIOUS: z.string().trim().min(32, { error: 'ожидается не меньше 32 знаков' }).optional(),
    // Чей заголовок Authentication-Results учитывать (решение 11 вехи M4). Не задан: отправитель письма не опознаётся.
    INBOUND_AUTHSERV_ID: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]{1,253}$/, { error: 'ожидается имя узла, например amazonses.com' })
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
    // Размер каждого из двух пулов соединений процесса (роль приложения и роль входа). При двух копиях портала
    // уменьшается, чтобы сумма не заняла больше 60% предела базы (src/db/pool-size.ts, решение 0039).
    DB_POOL_MAX: z.coerce.number({ error: 'ожидается целое число от 2 до 50' }).int({ error: 'ожидается целое число от 2 до 50' }).min(2, { error: 'ожидается целое число от 2 до 50' }).max(50, { error: 'ожидается целое число от 2 до 50' }).optional(),
    // Формат журнала: строки JSON для сбора и поиска (по умолчанию в production) или текст для окна разработчика.
    LOG_FORMAT: z.enum(['json', 'text'], { error: 'ожидается json или text' }).optional(),
    // Заголовок, из которого берётся адрес посетителя для счётчиков частоты и журнала аудита (итоговая проверка M1).
    // За Cloudflare это cf-connecting-ip. Не задан: x-forwarded-for, только для localhost.
    CLIENT_IP_HEADER: clientIpHeaderField,
    // Хранилище вложений (раздел 11.11, решение 0027): local только для машины разработчика, r2 для серверов.
    FILE_STORAGE: z.enum(['local', 'r2'], { error: 'ожидается local или r2' }).default('local'),
    FILE_STORAGE_DIR: z.string().trim().min(1, { error: 'пустое значение' }).default('.storage'),
    R2_ENDPOINT: httpsOrigin.optional(),
    R2_BUCKET: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, { error: 'ожидается имя бакета: строчные латинские буквы, цифры и -' })
      .optional(),
    R2_ACCESS_KEY_ID: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    R2_SECRET_ACCESS_KEY: z.string().trim().min(1, { error: 'пустое значение' }).optional(),
    // Антивирус ClamAV (решение 0027). Без адреса работает заглушка, она узнаёт только тестовую строку EICAR.
    CLAMAV_HOST: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]{1,253}$/, { error: 'ожидается имя узла или адрес IPv4' })
      .optional(),
    CLAMAV_PORT: z.coerce.number({ error: 'ожидается номер порта' }).int().min(1, { error: 'ожидается номер порта' }).max(65535, { error: 'ожидается номер порта' }).default(3310),
    // Смысловые векторы подсказки (ТЗ 11.11 EmbeddingProvider; план M5, решения 5 и 6): stub считает детерминированный
    // вектор по буквосочетаниям прямо в процессе, tei ходит в локальный контейнер TEI с моделью BGE-M3.
    EMBEDDINGS: z.enum(['stub', 'tei'], { error: 'ожидается stub или tei' }).default('stub'),
    EMBEDDINGS_URL: embeddingsUrl.optional(),
    // Поиск (план W6, решение 15): postgres ищет прежними запросами (по умолчанию; production до сервера 16 ГБ,
    // решение 0070), typesense ходит в локальный Typesense за идентификаторами, stub держит индекс в памяти процесса
    // (тесты и машина разработчика). Ключи поиска только documents:search: клиентский не видит переписку и
    // справочники, ключ сотрудника видит. Ключа записи у портала нет: его разбирает parseSearchWriteEnv.
    SEARCH_PROVIDER: z.enum(['postgres', 'typesense', 'stub'], { error: 'ожидается postgres, typesense или stub' }).default('postgres'),
    TYPESENSE_URL: internalUrl('http://typesense:8108').optional(),
    TYPESENSE_SEARCH_KEY: typesenseKey.optional(),
    TYPESENSE_STAFF_SEARCH_KEY: typesenseKey.optional(),
    // Таск-менеджер разработки (ТЗ 7.9, решение 13 вехи M8): manual значит, что номер и ссылку задачи вводит сотрудник;
    // smartup: задачи создаёт портал через API таск-менеджера Smartup (docs/integrations/dev-tracker.md).
    DEV_TRACKER: z.enum(['manual', 'smartup'], { error: 'ожидается manual или smartup' }).default('manual'),
    // Адрес API, токен портала и секрет подписи вебхука: обязательны все три, когда DEV_TRACKER равен smartup.
    DEV_TRACKER_URL: z
      .string()
      .trim()
      .refine(
        (value) => {
          const url = toUrl(value);
          return url !== null && (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
        },
        { error: 'ожидается адрес API вида https://tasks.example.com/api без параметров и учётной записи' },
      )
      .optional(),
    // Токен уходит заголовком Authorization: только печатные знаки ASCII без пробелов.
    DEV_TRACKER_TOKEN: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]{16,512}$/, { error: 'ожидается от 16 до 512 знаков: латинские буквы, цифры и знаки без пробелов' })
      .optional(),
    DEV_TRACKER_WEBHOOK_SECRET: z.string().trim().min(32, { error: 'ожидается не меньше 32 знаков' }).optional(),
  })
  .superRefine((value, ctx) => {
    const host = new URL(value.HUB_URL).hostname;
    if (value.HUB_DOMAIN !== host)
      ctx.addIssue({ code: 'custom', path: ['HUB_DOMAIN'], message: 'не совпадает с именем узла из HUB_URL' });
    // Первое значение x-forwarded-for за Cloudflare и Caddy это адрес узла Cloudflare или значение, которое прислал
    // сам посетитель. На настоящем адресе источник адреса посетителя выбирается явно (docs/runbooks/launch.md, раздел 8).
    if (value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host) && !value.CLIENT_IP_HEADER)
      ctx.addIssue({ code: 'custom', path: ['CLIENT_IP_HEADER'], message: 'не задан: за Cloudflare задайте cf-connecting-ip' });
    if (value.ENCRYPTION_KEY_PREVIOUS && value.ENCRYPTION_KEY_PREVIOUS === value.ENCRYPTION_KEY)
      ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY_PREVIOUS'], message: 'совпадает с ENCRYPTION_KEY: прежний ключ должен отличаться от текущего' });
    if (!value.EMBED_TOKEN_SECRET && value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['EMBED_TOKEN_SECRET'], message: 'не задан: без него виджет в Smartup Web не работает' });
    if (value.EMBED_TOKEN_SECRET && [value.BETTER_AUTH_SECRET, value.ENCRYPTION_KEY].includes(value.EMBED_TOKEN_SECRET))
      ctx.addIssue({ code: 'custom', path: ['EMBED_TOKEN_SECRET'], message: 'не должен совпадать с BETTER_AUTH_SECRET и ENCRYPTION_KEY' });
    if (value.REPLY_HMAC_SECRET_PREVIOUS && !value.REPLY_HMAC_SECRET)
      ctx.addIssue({ code: 'custom', path: ['REPLY_HMAC_SECRET_PREVIOUS'], message: 'задан без REPLY_HMAC_SECRET' });
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
    // Без секрета вебхука портал не узнаёт о входящих письмах и недоставке: на настоящем адресе он обязателен.
    if (value.MAIL_TRANSPORT === 'resend' && !value.RESEND_WEBHOOK_SECRET && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['RESEND_WEBHOOK_SECRET'], message: 'не задан, а MAIL_TRANSPORT равен resend: нужен секрет вебхука Resend' });
    if (value.REPLY_DOMAIN && !value.REPLY_HMAC_SECRET)
      ctx.addIssue({ code: 'custom', path: ['REPLY_HMAC_SECRET'], message: 'не задан, а REPLY_DOMAIN задан: задаются парой' });
    if (value.REPLY_HMAC_SECRET && !value.REPLY_DOMAIN)
      ctx.addIssue({ code: 'custom', path: ['REPLY_DOMAIN'], message: 'не задан, а REPLY_HMAC_SECRET задан: задаются парой' });
    if (value.REPLY_HMAC_SECRET && (value.REPLY_HMAC_SECRET === value.BETTER_AUTH_SECRET || value.REPLY_HMAC_SECRET === value.ENCRYPTION_KEY))
      ctx.addIssue({ code: 'custom', path: ['REPLY_HMAC_SECRET'], message: 'не должен совпадать с BETTER_AUTH_SECRET и ENCRYPTION_KEY' });
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
    if (value.FILE_STORAGE === 'r2')
      for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const)
        if (!value[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'не задана, а FILE_STORAGE равен r2' });
    // Локальное хранилище отдаёт файлы обработчиком портала и работает только на localhost.
    if (value.FILE_STORAGE !== 'r2' && value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['FILE_STORAGE'], message: 'на настоящем адресе в production задайте r2' });
    // Проверка "не робот" на формах входа (защита от перебора, ТЗ 14.5): без ключей она выключена, на настоящем адресе нельзя.
    if (!value.TURNSTILE_SITE_KEY && value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SITE_KEY'], message: 'не задан: на настоящем адресе в production формы входа защищает Cloudflare Turnstile' });
    if (!value.CLAMAV_HOST && value.NODE_ENV === 'production' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['CLAMAV_HOST'], message: 'не задан: на настоящем адресе в production файлы проверяет ClamAV' });
    if (value.EMBEDDINGS === 'tei' && !value.EMBEDDINGS_URL)
      ctx.addIssue({ code: 'custom', path: ['EMBEDDINGS_URL'], message: 'не задан, а EMBEDDINGS равен tei' });
    if (value.SEARCH_PROVIDER === 'typesense')
      for (const name of ['TYPESENSE_URL', 'TYPESENSE_SEARCH_KEY', 'TYPESENSE_STAFF_SEARCH_KEY'] as const)
        if (!value[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'не задана, а SEARCH_PROVIDER равен typesense' });
    if (value.TYPESENSE_SEARCH_KEY && value.TYPESENSE_SEARCH_KEY === value.TYPESENSE_STAFF_SEARCH_KEY)
      ctx.addIssue({ code: 'custom', path: ['TYPESENSE_STAFF_SEARCH_KEY'], message: 'совпадает с TYPESENSE_SEARCH_KEY: ключ сотрудника отдельный (решение 0070)' });
    if (value.SEARCH_PROVIDER === 'stub' && !LOCAL_HOSTS.has(host))
      ctx.addIssue({ code: 'custom', path: ['SEARCH_PROVIDER'], message: 'заглушка поиска допускается только для localhost и 127.0.0.1' });
    if (value.DEV_TRACKER === 'smartup')
      for (const name of ['DEV_TRACKER_URL', 'DEV_TRACKER_TOKEN', 'DEV_TRACKER_WEBHOOK_SECRET'] as const)
        if (!value[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'не задана, а DEV_TRACKER равен smartup' });
    // Токен портала уходит на этот адрес: только https. http нужен лишь ложному таск-менеджеру на машине разработчика.
    // Неразборчивый адрес уже отклонён проверкой самого поля.
    const tracker = value.DEV_TRACKER_URL ? toUrl(value.DEV_TRACKER_URL) : null;
    if (tracker) {
      if (tracker.protocol !== 'https:' && !(LOCAL_HOSTS.has(host) && LOCAL_HOSTS.has(tracker.hostname)))
        ctx.addIssue({ code: 'custom', path: ['DEV_TRACKER_URL'], message: 'http допускается только для localhost и только когда портал сам работает на localhost' });
    }
    if (value.DEV_TRACKER_WEBHOOK_SECRET && [value.BETTER_AUTH_SECRET, value.ENCRYPTION_KEY, value.DEV_TRACKER_TOKEN].includes(value.DEV_TRACKER_WEBHOOK_SECRET))
      ctx.addIssue({ code: 'custom', path: ['DEV_TRACKER_WEBHOOK_SECRET'], message: 'не должен совпадать с BETTER_AUTH_SECRET, ENCRYPTION_KEY и DEV_TRACKER_TOKEN' });
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

// --- Клиент Claude: только фоновый процесс (ТЗ 13.5, решение 97; план M5, решения 3 и 4) ---
//
// Ключ Anthropic задаётся только контейнеру worker (compose.prod.yaml, файл .env.worker). Схема портала выше его не
// содержит: веб-процесс ключа не требует и не читает, даже если переменная попала в его окружение. Разбирает эту схему
// только фабрика клиента модели (src/modules/hda/client/index.ts), её вызывают задачи фонового процесса.
// Имён моделей в коде нет: они задаются переменными (решение 4), рекомендованные значения в .env.example.

const aiSchema = z
  .object({
    HUB_URL: hubUrl,
    ANTHROPIC_API_KEY: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]{16,256}$/, { error: 'ожидается ключ API: от 16 до 256 печатных знаков без пробелов' })
      .optional(),
    AI_MODEL_FAST: z.string().trim().regex(/^[a-z0-9][a-z0-9.@:_-]{1,99}$/, { error: 'ожидается идентификатор модели, например из .env.example' }).optional(),
    AI_MODEL_QUALITY: z.string().trim().regex(/^[a-z0-9][a-z0-9.@:_-]{1,99}$/, { error: 'ожидается идентификатор модели, например из .env.example' }).optional(),
    // Заглушка модели с заготовленными ответами: разработка и браузерные тесты на localhost.
    AI_STUB: z.enum(['0', '1'], { error: 'ожидается 0 или 1' }).default('0'),
  })
  .superRefine((value, ctx) => {
    if (value.ANTHROPIC_API_KEY)
      for (const name of ['AI_MODEL_FAST', 'AI_MODEL_QUALITY'] as const)
        if (!value[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'не задана, а ANTHROPIC_API_KEY задан' });
    if (value.AI_STUB === '1' && !LOCAL_HOSTS.has(new URL(value.HUB_URL).hostname))
      ctx.addIssue({ code: 'custom', path: ['AI_STUB'], message: 'заглушка модели допускается только для localhost и 127.0.0.1' });
    else if (value.AI_STUB === '1' && value.ANTHROPIC_API_KEY)
      ctx.addIssue({ code: 'custom', path: ['AI_STUB'], message: 'заглушка и ANTHROPIC_API_KEY не задаются вместе' });
  });

/** Как фоновый процесс вызывает модель: без AI, заглушкой (localhost) или настоящим API. */
export type AiEnv = { mode: 'none' } | { mode: 'stub' } | { mode: 'anthropic'; apiKey: string; models: { fast: string; quality: string } };

export function parseAiEnv(source: Record<string, string | undefined>): AiEnv {
  const result = aiSchema.safeParse(source);
  if (!result.success)
    throw new EnvError(result.error.issues.map((issue) => ({ name: String(issue.path[0] ?? 'окружение'), reason: issue.message })));
  const value = result.data;
  if (value.AI_STUB === '1') return { mode: 'stub' };
  if (!value.ANTHROPIC_API_KEY || !value.AI_MODEL_FAST || !value.AI_MODEL_QUALITY) return { mode: 'none' };
  return { mode: 'anthropic', apiKey: value.ANTHROPIC_API_KEY, models: { fast: value.AI_MODEL_FAST, quality: value.AI_MODEL_QUALITY } };
}

// --- Запись в индекс поиска: только фоновый процесс и команда hub (план W6, решение 3) ---
//
// Ключ записи Typesense задаётся контейнерам worker и hub (файл .env.worker). Схема портала его не содержит: веб-процесс
// ключа не требует и не читает. Главный ключ Typesense (TYPESENSE_API_KEY) читает только команда hub search:keys.

const searchWriteSchema = z
  .object({
    SEARCH_PROVIDER: z.enum(['postgres', 'typesense', 'stub'], { error: 'ожидается postgres, typesense или stub' }).default('postgres'),
    TYPESENSE_URL: internalUrl('http://typesense:8108').optional(),
    TYPESENSE_WRITE_KEY: typesenseKey.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.SEARCH_PROVIDER === 'typesense')
      for (const name of ['TYPESENSE_URL', 'TYPESENSE_WRITE_KEY'] as const)
        if (!value[name]) ctx.addIssue({ code: 'custom', path: [name], message: 'не задана, а SEARCH_PROVIDER равен typesense' });
  });

/** Куда фоновый процесс пишет индекс: никуда (путь PostgreSQL), в заглушку или в Typesense. */
export type SearchWriteEnv = { mode: 'postgres' } | { mode: 'stub' } | { mode: 'typesense'; url: string; key: string };

export function parseSearchWriteEnv(source: Record<string, string | undefined>): SearchWriteEnv {
  const result = searchWriteSchema.safeParse(source);
  if (!result.success)
    throw new EnvError(result.error.issues.map((issue) => ({ name: String(issue.path[0] ?? 'окружение'), reason: issue.message })));
  const value = result.data;
  if (value.SEARCH_PROVIDER === 'typesense' && value.TYPESENSE_URL && value.TYPESENSE_WRITE_KEY) return { mode: 'typesense', url: value.TYPESENSE_URL, key: value.TYPESENSE_WRITE_KEY };
  return { mode: value.SEARCH_PROVIDER === 'stub' ? 'stub' : 'postgres' };
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
