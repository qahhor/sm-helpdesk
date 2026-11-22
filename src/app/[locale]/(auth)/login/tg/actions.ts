'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { completeTelegramLogin, nextRequest } from '@/modules/hdu/api';

/** Нажатие "Войти" на странице ссылки из бота: сама ссылка ничего не меняет (FR-ID-14). */
export async function completeTelegramLoginAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await completeTelegramLogin({ token: formData.get('token'), locale }, await nextRequest());
  if (result.ok) redirect(result.next);
  // Слишком много попыток с адреса: та же ссылка остаётся на странице, человек нажмёт кнопку позже.
  const token = formData.get('token');
  if (result.code === 'rate_limited' && typeof token === 'string') redirect(`/${locale}/login/tg?token=${encodeURIComponent(token)}&error=rate_limited`);
  // Токен в адрес ошибки не попадает.
  redirect(`/${locale}/login/tg?error=link_invalid`);
}
