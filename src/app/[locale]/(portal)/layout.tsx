import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { signOutAction } from '@/app/[locale]/session-actions';
import { getPolicyVersion } from '@/modules/hdc/api';
import { shownSupportAddress } from '@/modules/hdn/api/mail-settings';
import { unreadCount } from '@/modules/hdn/api/notifications';
import { listMyOrganizations, needsPolicyNotice, policyNoticePath, requireClientActor } from '@/modules/hdu/api';
import { ClientShell } from '@/ui/shell/client/ClientShell';
import { OrgSwitcher } from '@/ui/shell/client/OrgSwitcher';
import { NotificationBell } from '@/ui/shell/NotificationBell';
import { UserMenu } from '@/ui/shell/UserMenu';
import { bellLabels } from '../notifications-view';
import { clientUnreadAction } from './notifications/actions';
import { switchOrganizationAction } from './actions';

// Все страницы кабинета клиента идут в общей оболочке и только для участника организации (FR-ID-05).
// Раскладка при переходе между страницами не перерисовывается, поэтому каждая страница
// тоже вызывает requireClientActor: проверка на каждом запросе (ТЗ 9.4, правило 7).
export default async function PortalLayout({ children }: LayoutProps<'/[locale]'>) {
  const client = await requireClientActor();
  // Вышла новая редакция политики обработки данных: сначала короткий шаг о ней (решение 0017).
  // Адрес страницы сохраняется: после шага человек попадает туда, куда шёл.
  if (needsPolicyNotice(client.user, await getPolicyVersion())) redirect(await policyNoticePath());
  const t = await getTranslations();
  const orgs = client.orgCount > 1 ? await listMyOrganizations(client.user.id) : [];
  return (
    <ClientShell
      support={await shownSupportAddress()}
      bell={<NotificationBell href="/notifications" initialCount={await unreadCount(client.actor)} labels={await bellLabels()} refresh={clientUnreadAction} />}
      org={
        <OrgSwitcher
          current={{ id: client.org.id, name: client.org.name }}
          orgs={orgs.map((org) => ({ id: org.orgId, name: org.name }))}
          label={t('client.org.switch')}
          switchAction={switchOrganizationAction}
        />
      }
      userMenu={
        <UserMenu
          name={client.user.name}
          label={t('common.userMenu.label')}
          links={[
            { href: '/settings', label: t('common.userMenu.settings') },
            // Страница организации только администратору клиента (FR-ID-08).
            ...(client.actor.orgRole === 'client_admin' ? [{ href: '/org', label: t('common.userMenu.organization') }] : []),
          ]}
          signOutLabel={t('common.userMenu.signOut')}
          signOut={signOutAction}
        />
      }
    >
      {children}
    </ClientShell>
  );
}
