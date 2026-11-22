import { getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { listNotifications } from '@/modules/hdn/api/notifications';
import { requireClientActor } from '@/modules/hdu/api';
import { NotificationsList } from '@/ui/components/NotificationsList';
import { moreHrefOf, notificationItems, notificationLabels } from '../../notifications-view';
import { markAllClientAction, openClientNotificationAction } from './actions';

// Уведомления клиента (FR-NT-03): что произошло по его обращениям и обращениям, на которые он подписан.
export default async function ClientNotificationsPage({ searchParams }: PageProps<'/[locale]/notifications'>) {
  const client = await requireClientActor();
  const t = await getTranslations('common.notifications');
  const before = firstParam((await searchParams).before);
  const rows = await listNotifications(client.actor, before ? { before } : {});
  return (
    <>
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <NotificationsList
        items={await notificationItems(rows)}
        labels={await notificationLabels()}
        open={openClientNotificationAction}
        markAll={markAllClientAction}
        moreHref={moreHrefOf('notifications', rows, 50)}
      />
    </>
  );
}
