// Модуль hdc, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { isIP } from 'node:net';
import { CLIENT_IP_HEADERS, type ClientIpHeader } from '@/env';

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

/** Заголовок адреса посетителя из настроек (CLIENT_IP_HEADER). Не задан: x-forwarded-for, так работает localhost. */
export function clientIpHeader(): ClientIpHeader {
  const configured = process.env.CLIENT_IP_HEADER;
  return (CLIENT_IP_HEADERS as readonly string[]).includes(configured ?? '') ? (configured as ClientIpHeader) : 'x-forwarded-for';
}

/**
 * Адрес посетителя из заголовка, который выставляет доверенный прокси (CLIENT_IP_HEADER, итоговая проверка M1):
 * за Cloudflare это cf-connecting-ip. У x-forwarded-for берётся первое значение. Только правильный адрес IPv4
 * или IPv6. Значение идёт в журнал аудита и в ключи счётчиков частоты (в виде хеша), решений о доступе на нём не строится.
 */
export function clientIp(headers: Headers, source: ClientIpHeader = clientIpHeader()): string | null {
  const raw = headers.get(source);
  const value = (source === 'x-forwarded-for' ? raw?.split(',')[0] : raw)?.trim();
  return value && isIP(value) !== 0 ? value : null;
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
