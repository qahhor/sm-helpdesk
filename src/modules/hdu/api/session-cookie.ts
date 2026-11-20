import { AUTH_COOKIE_PREFIX, SESSION_TTL_SEC } from '../pref';

// Продление куки сессии (FR-ID-10). Срок сессии в базе продлевает библиотека входа при обращении,
// но страница при отрисовке куку поставить не может. Поэтому прокси портала на запросе страницы
// ставит куку заново: то же значение, срок 30 дней.
//
// Файл без 'server-only' и без обращения к базе: его загружает прокси. Действительность сессии
// определяет только база, кука лишь не должна истечь раньше сессии.

const NAMES = [`__Secure-${AUTH_COOKIE_PREFIX}.session_token`, `${AUTH_COOKIE_PREFIX}.session_token`] as const;
/** Значение возвращается браузеру как есть, поэтому принимаются только знаки подписанного токена. */
const VALUE = /^[A-Za-z0-9%._~+/=-]{1,1024}$/;

/**
 * Строка Set-Cookie, продлевающая куку сессии из заголовка Cookie запроса. Пусто, если куки сессии нет.
 * Значение берётся из заголовка без раскодирования: браузер получает обратно те же байты.
 */
export function sessionCookieRefresh(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';').map((part) => part.trim());
  for (const name of NAMES) {
    const pair = pairs.find((part) => part.startsWith(`${name}=`));
    if (!pair) continue;
    const value = pair.slice(name.length + 1);
    if (!VALUE.test(value)) return null;
    const secure = name.startsWith('__Secure-') ? '; Secure' : '';
    return `${name}=${value}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; SameSite=Lax${secure}`;
  }
  return null;
}
