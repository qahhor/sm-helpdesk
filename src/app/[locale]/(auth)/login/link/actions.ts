'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { completeLoginLink, nextRequest } from '@/modules/hdu/api';

/** Нажатие "Войти" на странице ссылки: сама ссылка из письма ничего не меняет (решение 0016). */
export async function completeLoginLinkAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await completeLoginLink({ token: formData.get('token'), next: formData.get('next'), locale }, await nextRequest());
  // Токен в адрес ошибки не попадает.
  redirect(result.ok ? result.next : `/${locale}/login/link?error=link_invalid`);
}
