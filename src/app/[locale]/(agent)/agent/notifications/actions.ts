'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { markRead, openNotification, unreadCount } from '@/modules/hdn/api/notifications';
import { requireStaffActor } from '@/modules/hdu/api';

/** Счётчик колокольчика рабочего места после перехода между страницами (решение 5 вехи M4). */
export async function staffUnreadAction(): Promise<number> {
  const staff = await requireStaffActor();
  return unreadCount(staff.actor);
}

/** Открыть уведомление: отметка прочтения и переход к обращению или к настройке. */
export async function openStaffNotificationAction(formData: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const row = await openNotification(staff.actor, formData.get('id'));
  if (row?.kind === 'holidays_reminder') redirect(`/${locale}/agent/settings/sla`);
  if (row?.kind === 'ai_budget') redirect(`/${locale}/agent/settings/ai`);
  // Идеи (веха M7): сводка модерации ведёт во вкладку "Модерация", уведомление идеи на её карточку.
  if (row?.kind === 'idea_moderation_due') redirect(`/${locale}/agent/ideas?tab=moderation`);
  if (row?.kind === 'idea_cycle') redirect(`/${locale}/agent/ideas/cycles`);
  // Задача разработки известной проблемы (веха M5c, решение 25): на карточку проблемы.
  if (row?.kind === 'problem_dev_task' && typeof row.payload.problem === 'number') redirect(`/${locale}/agent/problems/${row.payload.problem}`);
  if (row && typeof row.payload.idea === 'number') redirect(`/${locale}/agent/ideas/${row.payload.idea}`);
  redirect(row?.ticketNumber ? `/${locale}/agent/tickets/SUP-${row.ticketNumber}` : `/${locale}/agent/notifications`);
}

export async function markAllStaffAction(): Promise<void> {
  const staff = await requireStaffActor();
  await markRead(staff.actor, 'all');
  redirect(`/${await getLocale()}/agent/notifications`);
}
