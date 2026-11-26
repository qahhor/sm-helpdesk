import 'server-only';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { NotificationRow } from '@/modules/hdn/api/notifications';
import type { NotificationItem } from '@/ui/components/NotificationsList';

// Тексты списка уведомлений и колокольчика: общие для кабинета клиента и рабочего места.

export async function notificationItems(rows: NotificationRow[]): Promise<NotificationItem[]> {
  const t = await getTranslations('common.notifications.kinds');
  const format = await getFormatter();
  return rows.map((row) => ({
    id: row.notificationId,
    // rule: название правила автоматизации в уведомлениях правил (веха M8).
    // score: оценка клиента в уведомлении о низкой оценке (веха M8).
    // idea, into, status, count: номер идеи, цель объединения, статус идеи и число идей на модерации (веха M7).
    text: t(row.kind, {
      number: row.ticketNumber ?? 0,
      year: Number(row.payload.year ?? 0),
      rule: String(row.payload.rule ?? ''),
      score: Number(row.payload.score ?? 0),
      idea: Number(row.payload.idea ?? 0),
      into: Number(row.payload.into ?? 0),
      status: String(row.payload.status ?? ''),
      count: Number(row.payload.count ?? 0),
    }),
    time: format.dateTime(row.createdOn, { dateStyle: 'medium', timeStyle: 'short' }),
    unread: row.readOn === null,
  }));
}

export async function notificationLabels() {
  const t = await getTranslations('common.notifications');
  return { empty: t('empty'), emptyText: t('emptyText'), markAll: t('markAll'), unread: t('unread'), more: t('more') };
}

export async function bellLabels() {
  const t = await getTranslations('common.notifications');
  return { none: t('bellNone'), some: t.raw('bellSome') as string };
}

/** Следующая страница списка: время последнего уведомления страницы. */
export function moreHrefOf(path: string, rows: NotificationRow[], pageSize: number): string | null {
  const last = rows[rows.length - 1];
  return rows.length >= pageSize && last ? `${path}?before=${encodeURIComponent(last.notificationId)}` : null;
}
