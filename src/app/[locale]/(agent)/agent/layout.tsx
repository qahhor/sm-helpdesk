import { getTranslations } from 'next-intl/server';
import { signOutStaffAction } from '@/app/[locale]/session-actions';
import { requireStaffActor } from '@/modules/hdu/api';
import { AgentShell } from '@/ui/shell/agent/AgentShell';
import { UserMenu } from '@/ui/shell/UserMenu';

// Все страницы рабочего места идут в общей оболочке и только для сотрудников (FR-ID-09).
// Раскладка при переходе между страницами не перерисовывается, поэтому каждая страница
// тоже вызывает requireStaffActor: проверка на каждом запросе (ТЗ 9.4, правило 7).
export default async function AgentLayout({ children }: LayoutProps<'/[locale]/agent'>) {
  const staff = await requireStaffActor();
  const t = await getTranslations('common.userMenu');
  return (
    <AgentShell
      role={staff.actor.staffRole}
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
