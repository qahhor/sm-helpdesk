'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { confirmEmailOfRequest } from '@/modules/hdu/api';

/**
 * Нажатие "Подтвердить адрес" на странице ссылки из письма. Подтверждает только вошедший владелец запроса
 * (проверка main, S2). Без входа страница предлагает войти и вернуться по той же ссылке.
 */
export async function confirmEmailAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const token = formData.get('token');
  const result = await confirmEmailOfRequest({ token });
  if (result.ok) redirect(`/${locale}/confirm-email?done=1`);
  // Без входа токен остаётся в адресе: после входа человек вернётся на эту же страницу и нажмёт кнопку.
  const keep = result.code === 'sign_in_required' && typeof token === 'string' ? `&token=${encodeURIComponent(token)}` : '';
  redirect(`/${locale}/confirm-email?error=${result.code}${keep}`);
}
