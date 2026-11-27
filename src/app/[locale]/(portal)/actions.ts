'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { dismissHints, isHduError, requireClientActor, switchOrganizationOfRequest } from '@/modules/hdu/api';
import { isHdpError } from '@/modules/hdp/api';
import { dismissAnnouncement } from '@/modules/hdp/api/announcements';

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

/** Кнопка "Понятно" под подсказками первого входа (UX-C-14): больше они не показываются. */
export async function dismissHintsAction(): Promise<void> {
  const client = await requireClientActor();
  await dismissHints(client);
  redirect(`/${await getLocale()}`);
}

/** Закрыть баннер объявления (FR-ANN-04): закрытие за себя хранится в базе, страница перерисовывается без баннера. */
export async function dismissAnnouncementAction(form: FormData): Promise<void> {
  const client = await requireClientActor();
  try {
    await dismissAnnouncement(client, { announcementId: String(form.get('announcementId') ?? '') });
  } catch (error) {
    if (!isHdpError(error)) throw error;
  }
  refresh();
}
