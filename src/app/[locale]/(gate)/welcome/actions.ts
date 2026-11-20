'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { completeWelcome, requestEmailConfirmation, requireClientActor, safeReturnPath } from '@/modules/hdu/api';

const welcomePath = (locale: string, next: string, extra: string) => `/${locale}/welcome?next=${encodeURIComponent(next)}${extra}`;

/** "Отправить ссылку": письмо подтверждения адреса, шаг первого входа пройден. */
export async function sendWelcomeLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const client = await requireClientActor();
  const result = await requestEmailConfirmation(client, { email: formData.get('email'), locale });
  if (!result.ok) redirect(welcomePath(locale, next, `&error=${result.code}`));
  await completeWelcome(client.user.id);
  redirect(welcomePath(locale, next, '&sent=1'));
}

/** "Пропустить": шаг больше не показывается, адрес можно указать позже в профиле. */
export async function skipWelcomeAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const client = await requireClientActor();
  await completeWelcome(client.user.id);
  redirect(next);
}
