// Политика CSP портала (ТЗ, раздел 14.4). Встроенные скрипты и стили разрешены только
// с одноразовым кодом запроса (nonce), unsafe-inline нет.

const TURNSTILE = 'https://challenges.cloudflare.com';
/** Адрес приёма отчётов о нарушениях: src/app/api/csp-report/route.ts. */
export const CSP_REPORT_PATH = '/api/csp-report';
const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Адрес источника для политики: только схема https, узел и порт. */
function assertOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CSP: ${name} должен быть адресом вида https://узел`);
  }
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error(`CSP: ${name} должен быть адресом вида https://узел`);
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
 * @param opts.frameAncestors кто может встраивать страницу. Только для страниц виджета /embed:
 *   адреса активных серверов Smartup. Без параметра встраивание запрещено.
 */
export function buildCsp(opts: {
  nonce: string;
  dev: boolean;
  storageOrigin?: string;
  frameAncestors?: readonly string[];
}): string {
  if (!NONCE.test(opts.nonce)) throw new Error('CSP: недопустимый одноразовый код');
  const nonce = `'nonce-${opts.nonce}'`;
  const storage = opts.storageOrigin ? ` ${assertOrigin(opts.storageOrigin, 'storageOrigin')}` : '';
  const ancestors =
    opts.frameAncestors && opts.frameAncestors.length > 0
      ? opts.frameAncestors.map((origin) => assertOrigin(origin, 'frameAncestors')).join(' ')
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

/** Заголовки, одинаковые для всех ответов. Их ставит next.config.ts. */
export const STATIC_SECURITY_HEADERS = [
  // Для ответов, которые не идут через прокси (обработчики /api, файлы): портал нельзя встроить
  // в чужую страницу. Для страниц виджета /embed запрет заменит список серверов Smartup (веха M4).
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
] as const;
