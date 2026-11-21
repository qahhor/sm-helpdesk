'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { acceptInvitation, nextRequest } from '@/modules/hdu/api';

/**
 * Нажатие "Принять приглашение": членство, затем кабинет (FR-ID-08). У адреса уже есть учётная запись,
 * а человек в неё не вошёл: страница просит войти и вернуться по той же ссылке (проверка main, S3).
 */
export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const token = formData.get('token');
  const result = await acceptInvitation({ token, name: formData.get('name') ?? undefined }, await nextRequest());
  if (result.ok) redirect(`/${locale}`);
  // Токен остаётся в адресе только для просьбы войти: после входа человек вернётся на эту страницу.
  const keep = result.code === 'sign_in_required' && typeof token === 'string' ? `&token=${encodeURIComponent(token)}` : '';
  redirect(`/${locale}/invite?error=${result.code}${keep}`);
}
