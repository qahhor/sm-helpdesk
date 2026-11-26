'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { saveIdeaMailPref, savePrefs } from '@/modules/hdn/api/notifications';
import { changeStaffPassword, isHduError, nextRequest, requireStaffActor, revokeMySessionOfRequest, revokeOtherSessionsOfRequest, signOut } from '@/modules/hdu/api';

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

export type PasswordChangeState = { error?: string };

const MIN_PASSWORD = 12;

/**
 * Сотрудник меняет свой пароль (ASVS 5.0.0, требования 6.2.2 и 6.2.3; план подготовки M9, задача 1): текущий пароль
 * и новый дважды. После смены все сессии завершены: страница входа с новым паролем.
 */
export async function changeStaffPasswordAction(_previous: PasswordChangeState, formData: FormData): Promise<PasswordChangeState> {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent.password.errors');
  const next = formData.get('newPassword');
  if (typeof next !== 'string' || next.length < MIN_PASSWORD) return { error: t('password_short') };
  if (next !== formData.get('newPasswordRepeat')) return { error: t('password_mismatch') };
  const current = formData.get('currentPassword');
  if (current === next) return { error: t('same_password') };
  try {
    await changeStaffPassword(staff, { currentPassword: current, newPassword: next }, await nextRequest());
  } catch (error) {
    if (!isHduError(error)) throw error;
    if (error.code === 'invalid_credentials') return { error: t('invalid_credentials') };
    if (error.code === 'weak_password') return { error: t('weak_password') };
    if (error.code === 'rate_limited') return { error: t('rate_limited', { minutes: Math.max(1, Math.ceil((error.retryAfterSec ?? 900) / 60)) }) };
    return { error: t('invalid_input') };
  }
  redirect(`/${await getLocale()}/staff/login?setup=1`);
}
