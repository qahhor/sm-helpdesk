import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaffActor } from '@/modules/hdu/api';
import { listWebhooks } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';

// "Вебхуки" (FR-AUTO-10, FR-ADM-11; план M8, задача 5): список разрешённых адресов. Портал вызывает только адреса
// из этого списка. Секрет подписи здесь не показывается никогда.

const DONE = new Set(['deleted']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);

export default async function WebhooksSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const w = await getTranslations('agent.settings.webhooks');
  const r = await getTranslations('agent.settings.rules');
  const { done, error } = await searchParams;
  const endpoints = await listWebhooks(staff);
  return (
    <>
      <PageHeader
        title={w('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: w('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <Link href="/agent/settings/webhooks/new" className={buttonVariants()}>
            {w('newWebhook')}
          </Link>
        }
      />
      <SettingsLayout {...await settingsNav('webhooks')}>
        {done && DONE.has(done) && <Alert tone="success">{w(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{w(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{w('intro')}</p>
        {endpoints.length === 0 ? (
          <Card>
            <EmptyState title={w('emptyTitle')} text={w('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={w('listLabel')}>
              <thead>
                <tr className="border-b border-border text-start text-muted-foreground">
                  {(['name', 'url', 'events', 'state', 'actions'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {w(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={endpoint.endpointId} data-webhook={endpoint.name} className="border-b border-border align-top last:border-b-0">
                    <th scope="row" className="px-3 py-3 text-start font-normal">
                      <Link href={`/agent/settings/webhooks/${endpoint.endpointId}`} className="break-words font-semibold text-link underline-offset-2 hover:underline">
                        {endpoint.name}
                      </Link>
                    </th>
                    <td className="wrap-anywhere px-3 py-3">{endpoint.url}</td>
                    <td className="px-3 py-3">{endpoint.events.length === 0 ? w('eventsNone') : endpoint.events.map((event) => r(`events.${event}`)).join(', ')}</td>
                    <td className="px-3 py-3">
                      <StatusLabel tone={endpoint.isEnabled ? 'green' : 'gray'}>{w(endpoint.isEnabled ? 'states.enabled' : 'states.disabled')}</StatusLabel>
                    </td>
                    <td className="px-3 py-3">
                      <Link href={`/agent/settings/webhooks/${endpoint.endpointId}`} className={buttonVariants({ variant: 'secondary', size: 'small' })} aria-label={w('openOf', { name: endpoint.name })}>
                        {w('open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </SettingsLayout>
    </>
  );
}
