'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { markRead, openNotification, unreadCount } from '@/modules/hdn/api/notifications';
import { requireClientActor } from '@/modules/hdu/api';

/** Счётчик колокольчика после перехода между страницами (решение 5 вехи M4). */
export async function clientUnreadAction(): Promise<number> {
  const client = await requireClientActor();
  return unreadCount(client.actor);
}

/** Открыть уведомление: отметка прочтения и переход к обращению; о привязке Telegram: в профиль. */
export async function openClientNotificationAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const locale = await getLocale();
  const row = await openNotification(client.actor, formData.get('id'));
  if (row?.kind === 'telegram_linked') redirect(`/${locale}/settings`);
  // Уведомления по идеям ведут на страницу идеи (веха M7): номер идеи в payload.idea.
  if (row && typeof row.payload.idea === 'number') redirect(`/${locale}/ideas/${row.payload.idea}`);
  redirect(row?.ticketNumber ? `/${locale}/tickets/SUP-${row.ticketNumber}` : `/${locale}/notifications`);
}

export async function markAllClientAction(): Promise<void> {
  const client = await requireClientActor();
  await markRead(client.actor, 'all');
  redirect(`/${await getLocale()}/notifications`);
}
