'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { forgetServer, nextRequest, rememberServer, safeReturnPath } from '@/modules/hdu/api';

const loginPath = (locale: string, next: string, extra = '') =>
  `/${locale}/login?next=${encodeURIComponent(next)}${extra}`;

/** Клиент выделенного сервера ввёл адрес своего Smartup (FR-ID-03). */
export async function rememberServerAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const result = await rememberServer(formData.get('address'), await nextRequest());
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
