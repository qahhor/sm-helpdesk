import 'server-only';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import type { RequestInfo } from './request';

/**
 * Запрос серверного действия или обработчика: заголовки из Next.js и запись кук в ответ.
 * Куки, которые вернула библиотека входа, переносятся в ответ с теми же атрибутами
 * (HttpOnly, SameSite, срок). Вызывать только там, где Next.js разрешает менять куки:
 * в серверном действии и в обработчике маршрута.
 */
export async function nextRequest(): Promise<RequestInfo> {
  const [incoming, jar] = await Promise.all([headers(), cookies()]);
  return {
    headers: new Headers(incoming),
    setCookies(responseHeaders) {
      const raw = responseHeaders.get('set-cookie');
      if (!raw) return;
      for (const [name, attributes] of parseSetCookieHeader(raw))
        if (name) jar.set(name, attributes.value, toCookieOptions(attributes));
    },
  };
}
