'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { completeTelegramLogin, nextRequest } from '@/modules/hdu/api';

/** Нажатие "Войти" на странице ссылки из бота: сама ссылка ничего не меняет (FR-ID-14). */
export async function completeTelegramLoginAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await completeTelegramLogin({ token: formData.get('token'), locale }, await nextRequest());
  // Токен в адрес ошибки не попадает.
  redirect(result.ok ? result.next : `/${locale}/login/tg?error=link_invalid`);
}
