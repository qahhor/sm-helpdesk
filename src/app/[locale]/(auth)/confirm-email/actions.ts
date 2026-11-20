'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { confirmEmail } from '@/modules/hdu/api';

/** Нажатие "Подтвердить адрес" на странице ссылки из письма. Вход не нужен. */
export async function confirmEmailAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await confirmEmail({ token: formData.get('token') });
  redirect(`/${locale}/confirm-email?${result.ok ? 'done=1' : `error=${result.code}`}`);
}
