import 'server-only';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit, rateKey } from '@/modules/hdc/rate-limit';
import { clientIp, problemResponse } from '@/modules/hdc/util';
import { getAuth } from '../auth/instance';
import { isAllowedAuthRequest } from '../util';

/**
 * Обработчик адресов /api/auth/*. Наружу открыт один: возврат с сервера Smartup.
 * Остальные адреса библиотеки отвечают 404 (решение 0012).
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
  if (!isAllowedAuthRequest(request.method, new URL(request.url).pathname)) return problemResponse(404, 'not_found');
  const limit = await consumeRateLimit(
    rateKey('sso-callback:ip', clientIp(request.headers) ?? 'unknown'),
    RATE_RULES.ssoCallbackPerIp,
  );
  if (!limit.allowed) return problemResponse(429, 'rate_limited', { 'Retry-After': String(limit.retryAfterSec) });
  return (await getAuth()).handler(request);
}
