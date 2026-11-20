'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { getPolicyVersion } from '@/modules/hdc/api';
import { acknowledgePolicy, completeWelcome, requestEmailConfirmation, requireClientActor, safeReturnPath } from '@/modules/hdu/api';

const welcomePath = (locale: string, next: string, extra: string) => `/${locale}/welcome?next=${encodeURIComponent(next)}${extra}`;

/** Шаг пройден: строку о политике действующей версии пользователь видел. Политика выключена: записывать нечего. */
async function finishStep(userId: string): Promise<void> {
  await completeWelcome(userId);
  const policy = await getPolicyVersion();
  if (policy) await acknowledgePolicy(userId, policy);
}

/** "Отправить ссылку": письмо подтверждения адреса, шаг первого входа пройден. */
export async function sendWelcomeLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const client = await requireClientActor();
  const result = await requestEmailConfirmation(client, { email: formData.get('email'), locale });
  if (!result.ok) redirect(welcomePath(locale, next, `&error=${result.code}`));
  await finishStep(client.user.id);
  redirect(welcomePath(locale, next, '&sent=1'));
}

/** "Пропустить": шаг больше не показывается, адрес можно указать позже в профиле. */
export async function skipWelcomeAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const client = await requireClientActor();
  await finishStep(client.user.id);
  redirect(next);
}

/** "Понятно" на коротком шаге о новой редакции политики. */
export async function acknowledgePolicyAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(formData.get('next'), `/${locale}`);
  const client = await requireClientActor();
  const policy = await getPolicyVersion();
  if (policy) await acknowledgePolicy(client.user.id, policy);
  redirect(next);
}
