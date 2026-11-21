// Модуль hdc, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { createHash } from 'node:crypto';
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

/** Ключ счётчика частоты: область и хеш значения (адрес, email, идентификатор). Значение в базу не попадает. */
export function rateKey(scope: string, value: string): string {
  const digest = createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `${scope}:${digest.slice(0, 32)}`;
}

/** Восемь групп адреса IPv6, со встроенным в конец адресом IPv4. */
function hextets(ip: string): number[] {
  let text = ip.toLowerCase();
  const v4 = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(2).map(Number) as [number, number, number, number];
    text = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...gap, ...right].map((group) => Number.parseInt(group, 16));
}

/**
 * Адрес для счётчиков частоты (проверка main, S6): IPv4 целиком, IPv6 по сети /64. Одному абоненту обычно
 * выдают целую сеть /64, и смена адреса внутри неё не должна обнулять счётчик. Без адреса общий ключ unknown.
 */
export function ipBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  if (isIP(ip) !== 6) return ip;
  const groups = hextets(ip);
  // Адрес IPv4 в записи IPv6 (::ffff:a.b.c.d) считается как IPv4.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** Ключ счётчика по адресу посетителя: одна функция для всех пределов "на адрес". */
export function ipRateKey(scope: string, headers: Headers, source?: ClientIpHeader): string {
  return rateKey(scope, ipBucket(clientIp(headers, source)));
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
