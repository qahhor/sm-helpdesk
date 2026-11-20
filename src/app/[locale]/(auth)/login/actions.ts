'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { forgetServer, nextRequest, rememberServer, requestLoginLink, safeReturnPath } from '@/modules/hdu/api';
import { BOT_TOKEN_FIELD } from '@/ui/components/BotCheckField';

const loginPath = (locale: string, next: string, extra = '') =>
  `/${locale}/login?next=${encodeURIComponent(next)}${extra}`;

/** Клиент выделенного сервера ввёл адрес своего Smartup (FR-ID-03). */
export async function rememberServerAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const result = await rememberServer(formData.get('address'), await nextRequest(), formData.get(BOT_TOKEN_FIELD));
  if (result.found) redirect(loginPath(locale, next));
  redirect(loginPath(locale, next, `&mode=server&server=${result.rateLimited ? 'rate_limited' : 'not_found'}`));
}

/** Забыть выбранный сервер и ввести другой адрес. */
export async function forgetServerAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  forgetServer(await nextRequest());
  redirect(loginPath(locale, next, '&mode=server'));
}

/**
 * Запрос ссылки для входа (FR-ID-06). Ответ один и тот же для любого адреса:
 * страница показывает одно сообщение, письмо уходит только на подтверждённый адрес клиента.
 */
export async function requestLoginLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  await requestLoginLink({ email: formData.get('email'), locale, next, botToken: formData.get(BOT_TOKEN_FIELD) }, await nextRequest());
  redirect(loginPath(locale, next, '&mode=link&sent=1'));
}
