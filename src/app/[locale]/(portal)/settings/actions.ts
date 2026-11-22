'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { savePrefs } from '@/modules/hdn/api/notifications';
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

/** Какие письма получать (FR-NT-04): письма о своих обращениях не выключаются, поэтому их в форме нет. */
export async function saveClientPrefsAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await savePrefs(client.actor, { watchedTickets: formData.get('watchedTickets') === 'on' });
  redirect(`/${await getLocale()}/settings?prefs=saved`);
}
