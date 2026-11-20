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

const PROBLEM_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

/**
 * Ответ об ошибке для HTTP API в формате application/problem+json (ТЗ 12.2):
 * код для машины, без внутренних подробностей.
 */
export function problemResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: PROBLEM_TITLES[status] ?? 'Error', status, code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...NO_STORE, ...headers },
  });
}
