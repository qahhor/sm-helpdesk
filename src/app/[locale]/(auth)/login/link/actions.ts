'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { completeLoginLink, nextRequest } from '@/modules/hdu/api';

/** Нажатие "Войти" на странице ссылки: сама ссылка из письма ничего не меняет (решение 0016). */
export async function completeLoginLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await completeLoginLink({ token: formData.get('token'), next: formData.get('next'), locale }, await nextRequest());
  if (result.ok) redirect(result.next);
  // Слишком много попыток с адреса: та же ссылка остаётся на странице, человек нажмёт кнопку позже.
  const token = formData.get('token');
  const next = formData.get('next');
  if (result.code === 'rate_limited' && typeof token === 'string')
    redirect(`/${locale}/login/link?token=${encodeURIComponent(token)}${typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : ''}&error=rate_limited`);
  // Токен в адрес ошибки не попадает.
  redirect(`/${locale}/login/link?error=link_invalid`);
}
