// Модуль hdu, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { SERVER_CODE_PATTERN } from './pref';

const SSO_CALLBACK = /^\/api\/auth\/sso\/callback\/([^/]+)$/;

/**
 * Какие запросы к библиотеке входа открыты снаружи. Только возврат с сервера Smartup:
 * /api/auth/sso/callback/<код сервера>. Остальные адреса библиотеки (их 54) портал снаружи не отдаёт:
 * вход, сессии и ссылки вызываются серверными действиями как функции (решение 0012).
 */
export function isAllowedAuthRequest(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  const code = SSO_CALLBACK.exec(pathname)?.[1];
  return code !== undefined && SERVER_CODE_PATTERN.test(code);
}

const MAX_RETURN_PATH = 2000;
const PLACEHOLDER_ORIGIN = 'http://hub.invalid';

/** Управляющие знаки (перевод строки, табуляция, нулевой байт и другие) и обратная косая черта. */
function hasUnsafeChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '\\') return true;
  }
  return false;
}

/**
 * Адрес возврата после входа: только путь внутри портала (ТЗ 14.3). Всё остальное заменяется запасным адресом.
 *
 * Отклоняются адреса с узлом и схемой, пути с двумя косыми чертами в начале, обратная косая черта
 * (браузеры читают её как обычную), управляющие знаки и те же приёмы в закодированном виде.
 */
export function safeReturnPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH) return fallback;
  if (raw[0] !== '/' || raw[1] === '/' || hasUnsafeChars(raw)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (decoded[1] === '/' || hasUnsafeChars(decoded)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.startsWith('//')) return fallback;
  return `${url.pathname}${url.search}`;
}
