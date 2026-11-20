'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { nextRequest, signOut } from '@/modules/hdu/api';

/** Выход сотрудника: сессия завершается, браузер возвращается на страницу входа сотрудников. */
export async function signOutStaffAction(): Promise<void> {
  await signOut(await nextRequest());
  redirect(`/${await getLocale()}/staff/login`);
}

/** Выход клиента: сессия завершается, браузер возвращается на страницу входа. */
export async function signOutAction(): Promise<void> {
  await signOut(await nextRequest());
  redirect(`/${await getLocale()}/login`);
}
