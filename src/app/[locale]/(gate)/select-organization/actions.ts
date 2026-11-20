'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHduError, safeReturnPath, switchOrganizationOfRequest } from '@/modules/hdu/api';

/** Выбор организации после входа. Затем кабинет открывает страницу, на которую человек шёл. */
export async function selectOrganizationAction(form: FormData): Promise<void> {
  const locale = await getLocale();
  const next = safeReturnPath(form.get('next'), `/${locale}`);
  try {
    await switchOrganizationOfRequest(form.get('orgId'));
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`/${locale}/select-organization?error=not_member&next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}
