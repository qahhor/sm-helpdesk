import { getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { listNotifications } from '@/modules/hdn/api/notifications';
import { requireStaffActor } from '@/modules/hdu/api';
import { NotificationsList } from '@/ui/components/NotificationsList';
import { PageHeader } from '@/ui/components/PageHeader';
import { moreHrefOf, notificationItems, notificationLabels } from '../../../notifications-view';
import { markAllStaffAction, openStaffNotificationAction } from './actions';

// Уведомления сотрудника (FR-NT-03): упоминания, ответы клиентов, нарушения сроков, вернувшиеся отложенные.
export default async function StaffNotificationsPage({ searchParams }: PageProps<'/[locale]/agent/notifications'>) {
  const staff = await requireStaffActor();
  const t = await getTranslations();
  const before = firstParam((await searchParams).before);
  const rows = await listNotifications(staff.actor, before ? { before } : {});
  return (
    <>
      <PageHeader
        title={t('common.notifications.title')}
        breadcrumbs={[{ label: t('agent.home.title'), href: '/agent' }, { label: t('common.notifications.title') }]}
        breadcrumbsLabel={t('agent.breadcrumbs')}
      />
      <NotificationsList
        items={await notificationItems(rows)}
        labels={await notificationLabels()}
        open={openStaffNotificationAction}
        markAll={markAllStaffAction}
        moreHref={moreHrefOf('notifications', rows, 50)}
      />
    </>
  );
}
