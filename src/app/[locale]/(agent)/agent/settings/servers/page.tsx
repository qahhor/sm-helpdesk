import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { listServers, requireStaffActor, type ServerView } from '@/modules/hdu/api';
import { buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3';

/** Итог последней проверки связи меткой: текстом, а не только цветом. */
function checkTone(server: ServerView): { tone: 'green' | 'danger' | 'gray'; key: 'ok' | 'fail' | 'never' } {
  if (!server.lastCheck) return { tone: 'gray', key: 'never' };
  return server.lastCheck.ok ? { tone: 'green', key: 'ok' } : { tone: 'danger', key: 'fail' };
}

// Реестр серверов Smartup (FR-ADM-01): список, строка открывает карточку сервера.
export default async function ServersPage() {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const servers = await listServers(staff.actor);
  const nav = await settingsNav('servers');

  return (
    <>
      <PageHeader
        title={t('settings.servers.title')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: t('settings.servers.title') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <Link href="/agent/settings/servers/new" className={buttonVariants()}>
            {t('settings.servers.add')}
          </Link>
        }
      />
      <SettingsLayout {...nav}>
        {servers.length === 0 ? (
          <Card>
            <EmptyState title={t('settings.servers.emptyTitle')} text={t('settings.servers.emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{t('settings.servers.code')}</th>
                  <th scope="col" className={head}>{t('settings.servers.name')}</th>
                  <th scope="col" className={head}>{t('settings.servers.address')}</th>
                  <th scope="col" className={head}>{t('settings.servers.isDefault')}</th>
                  <th scope="col" className={head}>{t('settings.servers.state')}</th>
                  <th scope="col" className={head}>{t('settings.servers.lastCheck')}</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => {
                  const check = checkTone(server);
                  return (
                    <tr key={server.code} className="h-row border-b border-border last:border-b-0">
                      <td className={cell}>
                        <Link href={`/agent/settings/servers/${server.code}`} className="font-medium text-link underline-offset-2 hover:underline">
                          {server.code}
                        </Link>
                      </td>
                      <td className={cell}>{server.name}</td>
                      <td className={`${cell} wrap-anywhere`}>{server.baseUrl}</td>
                      <td className={cell}>{server.isDefault ? t('settings.servers.yes') : t('settings.servers.no')}</td>
                      <td className={cell}>
                        <StatusLabel tone={server.state === 'active' ? 'green' : 'gray'}>{t(`settings.servers.states.${server.state}`)}</StatusLabel>
                      </td>
                      <td className={cell}>
                        <StatusLabel tone={check.tone}>{t(`settings.servers.check.${check.key}`)}</StatusLabel>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </SettingsLayout>
    </>
  );
}
