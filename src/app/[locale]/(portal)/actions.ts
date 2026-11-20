'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHduError, switchOrganizationOfRequest } from '@/modules/hdu/api';

/**
 * Переключение организации из шапки кабинета. Идентификатор из формы проверяет модуль идентичности:
 * принимается только организация с действующим членством. После переключения открывается главная:
 * открытая страница могла принадлежать прежней организации.
 */
export async function switchOrganizationAction(form: FormData): Promise<void> {
  try {
    await switchOrganizationOfRequest(form.get('orgId'));
  } catch (error) {
    // Чужая или отключённая организация: остаёмся в текущей, кабинет откроется с ней.
    if (!isHduError(error)) throw error;
  }
  // Шапка с названием организации живёт в раскладке, а раскладку переход между страницами не перерисовывает:
  // refresh() заставляет перерисовать всё дерево кабинета.
  refresh();
  redirect(`/${await getLocale()}`);
}
