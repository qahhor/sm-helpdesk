'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdnError, saveIdeaMailPref, savePrefs } from '@/modules/hdn/api/notifications';
import { isHduError, nextRequest, requestEmailConfirmation, requireClientActor, revokeMySessionOfRequest, revokeOtherSessionsOfRequest, signOut, unlinkTelegram } from '@/modules/hdu/api';

/** Раздел "Email для входа": письмо со ссылкой подтверждения адреса (FR-ID-07). */
export async function requestEmailConfirmationAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const client = await requireClientActor();
  const result = await requestEmailConfirmation(client, { email: formData.get('email'), locale });
  redirect(`/${locale}/settings?email=${result.ok ? 'sent' : result.code}`);
}

/** Завершение сессии на другом устройстве. Завершение текущей сессии это выход. */
export async function revokeSessionAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  let signedOut = false;
  try {
    ({ signedOut } = await revokeMySessionOfRequest(formData.get('sessionId')));
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`/${locale}/settings?session=not_found`);
  }
  if (signedOut) {
    await signOut(await nextRequest());
    redirect(`/${locale}/login`);
  }
  redirect(`/${locale}/settings?session=revoked`);
}

/** Завершить все другие сессии: текущая остаётся. */
export async function revokeOtherSessionsAction(): Promise<void> {
  await requireClientActor();
  await revokeOtherSessionsOfRequest();
  redirect(`/${await getLocale()}/settings?session=others`);
}

/** Отвязка Telegram кнопкой в профиле. Бот подтверждает отвязку в диалоге. */
export async function unlinkTelegramAction(): Promise<void> {
  const client = await requireClientActor();
  await unlinkTelegram(client);
  redirect(`/${await getLocale()}/settings?telegram=unlinked`);
}

/**
 * Каналы уведомлений (FR-NT-04, FR-NT-14; решение 3 вехи M4b). Почту о своих обращениях сервер выключает,
 * только если Telegram привязан и включён: иначе форма показывает, что нужно сделать.
 */
export async function saveClientPrefsAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const client = await requireClientActor();
  const on = (name: string) => formData.get(name) === 'on';
  try {
    await savePrefs(client.actor, {
      own: { email: on('ownEmail'), telegram: on('ownTelegram') },
      watched: { email: on('watchedEmail'), telegram: on('watchedTelegram') },
    });
  } catch (error) {
    if (!isHdnError(error)) throw error;
    redirect(`/${locale}/settings?prefs=need_telegram`);
  }
  redirect(`/${locale}/settings?prefs=saved`);
}

/** Письма об идеях (план M7, задача 8, FR-NT-04): отключаются всегда, колокольчик остаётся. */
export async function saveClientIdeaPrefAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await saveIdeaMailPref(client.actor, { email: formData.get('ideasEmail') === 'on' });
  redirect(`/${await getLocale()}/settings?prefs=ideas`);
}
