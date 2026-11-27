'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { nextRequest, signOut, touchStaffActivity } from '@/modules/hdu/api';

/** Выход сотрудника: сессия завершается, браузер возвращается на страницу входа сотрудников. */
export async function signOutStaffAction(): Promise<void> {
  await signOut(await nextRequest());
  redirect(`/${await getLocale()}/staff/login`);
}

/**
 * Действие сотрудника в рабочем месте (план M9, решение 8): отметка активности для срока бездействия 30 минут.
 * Сессию и права проверяет модуль hdu; входа нет: false, страница ведёт на вход при следующем переходе.
 */
export async function staffActivityAction(): Promise<boolean> {
  return touchStaffActivity();
}

/** Выход клиента: сессия завершается, браузер возвращается на страницу входа. */
export async function signOutAction(): Promise<void> {
  await signOut(await nextRequest());
  redirect(`/${await getLocale()}/login`);
}
