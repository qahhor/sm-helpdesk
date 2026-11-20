// Модуль hdc, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { isIP } from 'node:net';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Ответ проверки "процесс жив". От базы и внешних сервисов не зависит. */
export function healthResponse(): Response {
  return Response.json({ status: 'ok' }, { headers: NO_STORE });
}

/**
 * Ответ проверки "готов принимать запросы".
 * Подробности отказа в тело не попадают: адрес проверки открыт без входа.
 */
export async function readyResponse(ping: () => Promise<boolean>): Promise<Response> {
  let dbOk = false;
  try {
    dbOk = await ping();
  } catch {
    dbOk = false;
  }
  return Response.json(
    { status: dbOk ? 'ready' : 'not_ready', checks: { db: dbOk ? 'ok' : 'fail' } },
    { status: dbOk ? 200 : 503, headers: NO_STORE },
  );
}

/**
 * Адрес посетителя: первое значение заголовка x-forwarded-for, если это правильный адрес IPv4 или IPv6.
 * Заголовок выставляет обратный прокси перед приложением. Значение идёт в журнал аудита
 * и в ключи счётчиков частоты (в виде хеша), решений о доступе на нём не строится.
 */
export function clientIp(headers: Headers): string | null {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first && isIP(first) !== 0 ? first : null;
}
