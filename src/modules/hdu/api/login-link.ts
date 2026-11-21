import 'server-only';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientIp, consumeRateLimit, ipRateKey, rateKey } from '@/modules/hdc/api';
import { getBotCheck } from '@/security/bot-check';
import { getAuth } from '../auth/instance';
import { isLoginLinkRecipient } from '../core/email';
import { emailInput } from '../input';
import { safeReturnPath } from '../util';
import type { RequestInfo } from './request';

// Вход по ссылке на подтверждённый email (FR-ID-06, решение 0016).
//
// Ответ на запрос ссылки один и тот же для любого адреса: по нему нельзя узнать, есть ли такая учётная запись.
// Ссылка ведёт на страницу портала с кнопкой "Войти": почтовый сканер, открывший ссылку, её не тратит.

const localeOf = (value: unknown): Locale => (typeof value === 'string' && isLocale(value) ? value : DEFAULT_LOCALE);

/**
 * Запрос ссылки для входа. Письмо уходит, только если адрес подтверждён, это не сотрудник
 * и у человека есть действующее членство. Счётчики (5 в час на адрес, 20 в час на IP) считаются
 * для любого адреса. Отправка письма ответ не задерживает.
 */
export async function requestLoginLink(input: unknown, request: Pick<RequestInfo, 'headers'>): Promise<{ ok: true }> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const locale = localeOf(raw.locale);
  const next = safeReturnPath(raw.next, `/${locale}`);
  const email = emailInput.safeParse(raw.email);

  const ip = clientIp(request.headers);
  // Проверка "не робот" первой: робот не расходует счётчики адреса и не мешает человеку получить ссылку.
  // Не прошла: ответ тот же, письмо не уходит. Сервис недоступен: дальше решают счётчики.
  const check = getBotCheck();
  if (check.enabled && (await check.verify(raw.botToken, ip)) === 'failed') return { ok: true };

  const byIp = await consumeRateLimit(ipRateKey('login-link:ip', request.headers), RATE_RULES.loginLinkPerIp);
  // Сверх предела IP счётчик адреса не расходуется: поток с одного адреса не лишает человека его ссылок.
  if (!byIp.allowed || !email.success) return { ok: true };
  const byAddress = await consumeRateLimit(rateKey('login-link:email', email.data), RATE_RULES.loginLinkPerAddress);
  if (!byAddress.allowed) return { ok: true };
  if (!(await isLoginLinkRecipient(email.data))) return { ok: true };

  // Библиотека записывает хеш токена и вызывает отправку письма (auth/mail.ts) с языком и адресом возврата.
  const auth = await getAuth();
  await auth.api.signInMagicLink({ body: { email: email.data, metadata: { locale, next } }, headers: new Headers() });
  return { ok: true };
}

const completeInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });

/**
 * Вход по ссылке: нажатие кнопки "Войти" на странице ссылки. Ссылка срабатывает один раз и живёт 15 минут.
 * Недействительная, просроченная и использованная ссылка дают один ответ.
 */
export async function completeLoginLink(
  input: unknown,
  request: RequestInfo,
): Promise<{ ok: true; next: string } | { ok: false; code: 'link_invalid' }> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const locale = localeOf(raw.locale);
  const parsed = completeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'link_invalid' };
  const auth = await getAuth();
  try {
    // Без адреса возврата библиотека не перенаправляет, а отвечает данными сессии и куками.
    const result = await auth.api.magicLinkVerify({ query: { token: parsed.data.token }, headers: request.headers, returnHeaders: true });
    request.setCookies(result.headers);
  } catch (error) {
    // Ошибки ссылки библиотека отдаёт перенаправлением на страницу ошибки: для нас это одна причина.
    if (isAPIError(error)) return { ok: false, code: 'link_invalid' };
    throw error;
  }
  return { ok: true, next: safeReturnPath(raw.next, `/${locale}`) };
}
