import { getTranslations } from 'next-intl/server';
import { signOutStaffAction } from '@/app/[locale]/session-actions';
import { unreadCount } from '@/modules/hdn/api/notifications';
import { requireStaffActor } from '@/modules/hdu/api';
import { AgentShell } from '@/ui/shell/agent/AgentShell';
import { NotificationBell } from '@/ui/shell/NotificationBell';
import { UserMenu } from '@/ui/shell/UserMenu';
import { bellLabels } from '../../notifications-view';
import { staffUnreadAction } from './notifications/actions';

// Все страницы рабочего места идут в общей оболочке и только для сотрудников (FR-ID-09).
// Раскладка при переходе между страницами не перерисовывается, поэтому каждая страница
// тоже вызывает requireStaffActor: проверка на каждом запросе (ТЗ 9.4, правило 7).
export default async function AgentLayout({ children }: LayoutProps<'/[locale]/agent'>) {
  const staff = await requireStaffActor();
  const t = await getTranslations('common.userMenu');
  return (
    <AgentShell
      role={staff.actor.staffRole}
      bell={<NotificationBell href="/agent/notifications" initialCount={await unreadCount(staff.actor)} labels={await bellLabels()} refresh={staffUnreadAction} />}
      userMenu={
        <UserMenu
          name={staff.user.name}
          label={t('label')}
          links={[{ href: '/agent/account', label: t('sessions') }]}
          signOutLabel={t('signOut')}
          signOut={signOutStaffAction}
        />
      }
    >
      {children}
    </AgentShell>
  );
}
