import { getTranslations } from 'next-intl/server';
import { signOutAction } from '@/app/[locale]/session-actions';
import { listMyOrganizations, requireClientActor } from '@/modules/hdu/api';
import { ClientShell } from '@/ui/shell/client/ClientShell';
import { OrgSwitcher } from '@/ui/shell/client/OrgSwitcher';
import { UserMenu } from '@/ui/shell/UserMenu';
import { switchOrganizationAction } from './actions';

// Все страницы кабинета клиента идут в общей оболочке и только для участника организации (FR-ID-05).
// Раскладка при переходе между страницами не перерисовывается, поэтому каждая страница
// тоже вызывает requireClientActor: проверка на каждом запросе (ТЗ 9.4, правило 7).
export default async function PortalLayout({ children }: LayoutProps<'/[locale]'>) {
  const client = await requireClientActor();
  const t = await getTranslations();
  const orgs = client.orgCount > 1 ? await listMyOrganizations(client.user.id) : [];
  return (
    <ClientShell
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
