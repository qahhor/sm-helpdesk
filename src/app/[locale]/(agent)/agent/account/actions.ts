'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { saveIdeaMailPref, savePrefs } from '@/modules/hdn/api/notifications';
import { isHduError, nextRequest, requireStaffActor, revokeMySessionOfRequest, revokeOtherSessionsOfRequest, signOut } from '@/modules/hdu/api';

/** Завершение сессии сотрудника на другом устройстве. Пишется в журнал аудита. Текущая: это выход. */
export async function revokeStaffSessionAction(formData: FormData): Promise<void> {
  await requireStaffActor();
  const locale = await getLocale();
  let signedOut = false;
  try {
    ({ signedOut } = await revokeMySessionOfRequest(formData.get('sessionId')));
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`/${locale}/agent/account?session=not_found`);
  }
  if (signedOut) {
    await signOut(await nextRequest());
    redirect(`/${locale}/staff/login`);
  }
  redirect(`/${locale}/agent/account?session=revoked`);
}

/** Завершить все другие сессии сотрудника: текущая остаётся. Пишется в журнал аудита. */
export async function revokeOtherStaffSessionsAction(): Promise<void> {
  await requireStaffActor();
  await revokeOtherSessionsOfRequest();
  redirect(`/${await getLocale()}/agent/account?session=others`);
}

/** Письма сотруднику (решение 7 вехи M4): об упоминаниях и о нарушениях сроков. Уведомления в портале приходят всегда. */
export async function saveStaffPrefsAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await savePrefs(staff.actor, { staffMention: formData.get('staffMention') === 'on', staffBreach: formData.get('staffBreach') === 'on' });
  redirect(`/${await getLocale()}/agent/account?prefs=saved`);
}

/** Письма об идеях (план M7, задача 8, FR-NT-04): отключаются всегда. */
export async function saveStaffIdeaPrefAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  await saveIdeaMailPref(staff.actor, { email: formData.get('ideasEmail') === 'on' });
  redirect(`/${await getLocale()}/agent/account?prefs=ideas`);
}
