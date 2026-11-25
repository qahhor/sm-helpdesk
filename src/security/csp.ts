// Политика CSP портала (ТЗ, раздел 14.4). Встроенные скрипты и стили разрешены только
// с одноразовым кодом запроса (nonce), unsafe-inline нет.

const TURNSTILE = 'https://challenges.cloudflare.com';
/** Адрес приёма отчётов о нарушениях: src/app/api/csp-report/route.ts. */
export const CSP_REPORT_PATH = '/api/csp-report';
const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/**
 * Адрес источника для политики: только схема https, узел и порт. allowLoopbackHttp: портал сам работает на localhost,
 * тогда допускается и http для localhost и 127.0.0.1 (демонстрационная страница Smartup Web, решение 0015).
 */
function assertOrigin(value: string, name: string, allowLoopbackHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CSP: ${name} должен быть адресом вида https://узел`);
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.origin !== value) throw new Error(`CSP: ${name} должен быть адресом вида https://узел`);
  return value;
}

/**
 * Адрес хранилища файлов для политики: браузер кладёт файлы в R2 и показывает картинки оттуда (решение 0027).
 * Локальное хранилище отдаёт файлы с адреса портала, ему отдельный источник не нужен. Значение проверено src/env.ts.
 */
export function storageOriginOf(source: Record<string, string | undefined>): string | undefined {
  return source.FILE_STORAGE === 'r2' && source.R2_ENDPOINT ? source.R2_ENDPOINT : undefined;
}

/** Одноразовый код запроса: 16 случайных байт в base64. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Собирает значение заголовка Content-Security-Policy.
 *
 * @param opts.nonce одноразовый код запроса
 * @param opts.dev режим разработки: React использует eval для отладки
 * @param opts.storageOrigin адрес хранилища файлов, появляется вместе с вложениями
 * @param opts.frameAncestors кто может встраивать страницу. Только для страниц виджета /embed: адреса сервера Smartup,
 *   чей ключ встраивания стоит в адресе страницы (решение 6 плана M6). Без параметра встраивание запрещено.
 * @param opts.allowLoopbackAncestors портал работает на localhost: в frameAncestors допускается http для localhost
 *   и 127.0.0.1.
 */
export function buildCsp(opts: {
  nonce: string;
  dev: boolean;
  storageOrigin?: string;
  frameAncestors?: readonly string[];
  allowLoopbackAncestors?: boolean;
}): string {
  if (!NONCE.test(opts.nonce)) throw new Error('CSP: недопустимый одноразовый код');
  const nonce = `'nonce-${opts.nonce}'`;
  const storage = opts.storageOrigin ? ` ${assertOrigin(opts.storageOrigin, 'storageOrigin')}` : '';
  const ancestors =
    opts.frameAncestors && opts.frameAncestors.length > 0
      ? opts.frameAncestors.map((origin) => assertOrigin(origin, 'frameAncestors', opts.allowLoopbackAncestors)).join(' ')
      : "'none'";

  return [
    "default-src 'self'",
    `script-src 'self' ${nonce}${opts.dev ? " 'unsafe-eval'" : ''} ${TURNSTILE}`,
    `style-src 'self' ${nonce}`,
    // blob: миниатюры выбранных файлов до отправки (URL.createObjectURL), только из памяти страницы.
    `img-src 'self' data: blob:${storage}`,
    `connect-src 'self'${storage}`,
    `frame-src ${TURNSTILE}`,
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    // Нарушения приходят порталу (проверка main, S9). report-to не задан: с ним Chrome перестаёт
    // слать отчёты на report-uri, а Firefox report-to не знает.
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/**
 * Политика действует (ТЗ 14.4; аудит 23.11.2026, находка S2): нарушение блокируется, отчёт о нём приходит порталу.
 * До волны 0 плана аудита она работала в режиме отчётов; браузерные тесты подтвердили, что страницы её не нарушают.
 */
export const CSP_HEADER = 'Content-Security-Policy';

/** Заголовки, одинаковые для всех ответов, кроме страниц виджета. Их ставит next.config.ts (staticHeaderRules). */
export const STATIC_SECURITY_HEADERS = [
  // Для ответов, которые не идут через прокси (обработчики /api, файлы): портал нельзя встроить
  // в чужую страницу. Для страниц виджета /embed запрет заменяет список адресов сервера Smartup (staticHeaderRules).
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
] as const;

/** Та же статическая политика для страниц виджета: без frame-ancestors, его ставит прокси по ключу сервера. */
export const EMBED_STATIC_CSP = { key: 'Content-Security-Policy', value: "base-uri 'none'; object-src 'none'" } as const;

/**
 * Правила заголовков для next.config.ts (план M6, задача 3). Браузер применяет каждый заголовок CSP: статический
 * frame-ancestors 'none' на странице виджета запретил бы встраивание при любом списке прокси. Поэтому страницы
 * /{язык}/embed (и адрес без языка, который прокси перенаправляет) получают статическую политику без frame-ancestors,
 * а все остальные адреса, включая /api/embed/* и /{язык}/m/*, сохраняют запрет. X-Frame-Options портал не ставит
 * нигде: он не умеет списка адресов и спорил бы с frame-ancestors.
 */
export function staticHeaderRules(locales: readonly string[]): { source: string; headers: { key: string; value: string }[] }[] {
  if (!locales.every((locale) => /^[a-z]{2}$/.test(locale))) throw new Error('CSP: код языка из двух строчных букв');
  // Без точки после embed: адрес с расширением файла прокси не обрабатывает (matcher в src/proxy.ts), frame-ancestors
  // по ключу ему никто не поставит, поэтому он сохраняет статический запрет (замечание M4 проверки M6). У страниц
  // виджета точек в адресе нет.
  const embed = `(?:(?:${locales.join('|')})/)?embed(?:/[^.]*)?`;
  const [csp, ...common] = STATIC_SECURITY_HEADERS;
  // Страницы виджета и мобильного приложения (план M6, задачи 4 и 7): без Referer. Правило стоит ниже общего, и Next.js
  // берёт его значение того же заголовка. Загрузчик виджета: кеш 5 минут, данных клиентов в нём нет (решение 9).
  const widgetPages = `(?:${locales.join('|')})/(?:embed|m)(?:/.*)?`;
  return [
    { source: '/:path*', headers: [...common] },
    { source: `/:path((?!${embed}$).*)`, headers: [csp] },
    { source: `/:path(${embed})`, headers: [EMBED_STATIC_CSP] },
    { source: `/:path(${widgetPages})`, headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    { source: '/widget/v1/:file*', headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }] },
  ];
}
