import 'server-only';
import { isAPIError } from 'better-auth/api';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { RATE_RULES } from '@/modules/hdc/pref';
import { consumeRateLimit } from '@/modules/hdc/rate-limit';
import { clientIp, ipRateKey } from '@/modules/hdc/util';
import { getBotCheck } from '@/security/bot-check';
import { getAuth } from '../auth/instance';
import { SERVER_CODE_PATTERN } from '../pref';
import { safeReturnPath } from '../util';
import type { RequestInfo } from './request';
import { findLoginServer, findServerByAddress } from './servers';

// Вход клиента через Smartup (FR-ID-01..03). Список серверов наружу не отдаётся: клиент общего облака
// видит одну кнопку, клиент выделенного сервера один раз вводит адрес своего Smartup, выбор запоминается.

/** Кука с кодом выбранного сервера Smartup. Значение проверяется при чтении. */
export const SERVER_COOKIE = 'hub_server';
const SERVER_COOKIE_MAX_AGE = 365 * 24 * 3600;

function readCookie(headers: Headers, name: string): string | null {
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Код сервера из куки, если он записан правильно. */
function rememberedCode(headers: Headers): string | null {
  const code = readCookie(headers, SERVER_COOKIE);
  return code && SERVER_CODE_PATTERN.test(code) ? code : null;
}

function serverCookie(value: string, maxAge: number): Headers {
  const secure = getEnv().HUB_URL.startsWith('https://') ? '; Secure' : '';
  return new Headers({ 'set-cookie': `${SERVER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}` });
}

export type LoginServerState =
  | { state: 'default' }
  | { state: 'remembered'; host: string }
  /** Сервер из куки отключён: вход на другой сервер сам не переключается. */
  | { state: 'unavailable' }
  /** Сервера по умолчанию нет: клиенту нужно ввести адрес своего Smartup. */
  | { state: 'none' };

/** Что показать на странице входа: кнопку общего облака, запомненный сервер или поле адреса. */
export async function describeLoginServer(request: Pick<RequestInfo, 'headers'>): Promise<LoginServerState> {
  const code = rememberedCode(request.headers);
  if (code) {
    const server = await findLoginServer({ code });
    return server ? { state: 'remembered', host: server.host } : { state: 'unavailable' };
  }
  return (await findLoginServer({})) ? { state: 'default' } : { state: 'none' };
}

/**
 * Начало входа через Smartup: адрес страницы входа сервера, куда отправить браузер.
 * Библиотека входа ставит куку состояния и запоминает проверочный код PKCE.
 */
export async function startSmartupSignIn(
  input: { next?: unknown; locale: Locale },
  request: RequestInfo,
): Promise<{ url: string } | { error: 'no_server' | 'rate_limited' | 'server_unavailable' }> {
  const limit = await consumeRateLimit(ipRateKey('sso-start:ip', request.headers), RATE_RULES.ssoStartPerIp);
  if (!limit.allowed) return { error: 'rate_limited' };
  const code = rememberedCode(request.headers);
  // Кука есть, но её значение неверно: на сервер по умолчанию не переключаемся.
  if (code === null && readCookie(request.headers, SERVER_COOKIE) !== null) return { error: 'no_server' };
  const server = await findLoginServer({ code });
  if (!server) return { error: 'no_server' };
  // Сервер только что добавили: экземпляр библиотеки должен его знать.
  const auth = await getAuth({ refresh: true });
  let result;
  try {
    result = await auth.api.signInSSO({
      body: {
        providerId: server.code,
        // После входа сначала шаг первого входа: он сам пропускает дальше, если не нужен (FR-ID-07).
        callbackURL: `/${input.locale}/welcome?next=${encodeURIComponent(safeReturnPath(input.next, `/${input.locale}`))}`,
        errorCallbackURL: `/${input.locale}/login?error=sso`,
      },
      headers: request.headers,
      returnHeaders: true,
    });
  } catch (error) {
    // Сервер Smartup не отдал документ discovery (не отвечает, ошибка, неверный ответ): человек видит
    // понятное сообщение на странице входа, а не ошибку портала (итоговая проверка M1).
    if (isAPIError(error)) {
      console.error(`Вход через сервер ${server.code} не начат: ${error.message}`);
      return { error: 'server_unavailable' };
    }
    throw error;
  }
  request.setCookies(result.headers);
  return { url: result.response.url };
}

/**
 * Клиент выделенного сервера ввёл адрес своего Smartup. Найденный сервер запоминается кукой на год.
 * Ответ не раскрывает, какие серверы есть в реестре. Поиск ограничен по частоте (решение 0014).
 */
export async function rememberServer(
  address: unknown,
  request: Pick<RequestInfo, 'headers' | 'setCookies'>,
  botToken?: unknown,
): Promise<{ found: boolean; rateLimited?: boolean }> {
  const ip = clientIp(request.headers);
  // Проверка "не робот": робот, перебирающий адреса, получает тот же ответ "не найден" (решение 0018).
  const check = getBotCheck();
  if (check.enabled && (await check.verify(botToken, ip)) === 'failed') return { found: false };
  const limit = await consumeRateLimit(ipRateKey('server-lookup:ip', request.headers), RATE_RULES.serverLookupPerIp);
  if (!limit.allowed) return { found: false, rateLimited: true };
  const server = await findServerByAddress(address);
  if (!server) return { found: false };
  request.setCookies(serverCookie(server.code, SERVER_COOKIE_MAX_AGE));
  return { found: true };
}

/** Забыть выбранный сервер: снова кнопка общего облака. */
export function forgetServer(request: RequestInfo): void {
  request.setCookies(serverCookie('', 0));
}
