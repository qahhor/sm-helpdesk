'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { acceptInvitation, nextRequest } from '@/modules/hdu/api';

/** Нажатие "Принять приглашение": членство и сессия, затем кабинет (FR-ID-08). */
export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const result = await acceptInvitation({ token: formData.get('token'), name: formData.get('name') ?? undefined }, await nextRequest());
  // Токен в адрес ошибки не попадает.
  redirect(result.ok ? `/${locale}` : `/${locale}/invite?error=${result.code}`);
}
