import 'server-only';
import { describeCspReports } from '@/security/csp-report';
import { RATE_RULES } from './pref';
import { consumeRateLimit } from './rate-limit';
import { ipRateKey, problemResponse, readLimited } from './util';

// Модуль hdc: приём отчётов о нарушениях CSP, POST /api/csp-report (проверка main, S9).
// Адрес открыт без входа: тип тела, размер и частота с одного адреса ограничены.

const TYPES = new Set(['application/csp-report', 'application/reports+json', 'application/json']);
const BODY_LIMIT = 16 * 1024;

/** Принимает отчёт: 204; другой метод 405, другой тип 415, тело больше 16 КБ 413, не JSON 400, частота 429. */
export async function handleCspReport(request: Request): Promise<Response> {
  if (request.method !== 'POST') return problemResponse(405, 'method_not_allowed', { Allow: 'POST' });
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!TYPES.has(type)) return problemResponse(415, 'unsupported_media_type');
  const limit = await consumeRateLimit(ipRateKey('csp-report:ip', request.headers), RATE_RULES.cspReportPerIp);
  if (!limit.allowed) return problemResponse(429, 'rate_limited', { 'Retry-After': String(limit.retryAfterSec) });
  const text = await readLimited(request, BODY_LIMIT);
  if (text === null) return problemResponse(413, 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return problemResponse(400, 'invalid_json');
  }
  for (const line of describeCspReports(body)) console.warn(line);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
