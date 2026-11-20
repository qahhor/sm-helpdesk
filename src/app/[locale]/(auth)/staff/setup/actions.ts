'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { acceptStaffInvitation, isHduError } from '@/modules/hdu/api';

export type StaffSetupState = { error?: string };

const MIN_PASSWORD = 12;

/** Сотрудник задаёт пароль по ссылке приглашения. Дальше он входит и подключает второй фактор. */
export async function staffSetupAction(_previous: StaffSetupState, formData: FormData): Promise<StaffSetupState> {
  const t = await getTranslations('auth.staff.setup.errors');
  const password = formData.get('password');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return { error: t('password_short') };
  if (password !== formData.get('passwordRepeat')) return { error: t('password_mismatch') };

  try {
    await acceptStaffInvitation({ token: formData.get('token'), name: formData.get('name'), password });
  } catch (error) {
    if (!isHduError(error)) throw error;
    if (error.code === 'link_invalid') return { error: t('link_invalid') };
    if (error.code === 'email_taken') return { error: t('email_taken') };
    return { error: t('invalid_input') };
  }
  redirect(`/${await getLocale()}/staff/login?setup=1`);
}
