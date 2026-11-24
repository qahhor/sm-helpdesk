import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { requireStaffActor } from '@/modules/hdu/api';
import { type DeliveryRecord, listWebhookDeliveries, readWebhook } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../../sections';
import { ConfirmDelete } from '../../ConfirmDelete';
import { deleteWebhookAction, sendTestAction } from '../actions';
import { secretLabels, webhookFormProps } from '../form-labels';
import { RotateSecret } from '../RotateSecret';
import { WebhookForm } from '../WebhookForm';

// Адрес вебхука (FR-AUTO-10, FR-ADM-11; план M8, задача 5): правка, смена секрета, проверочная отправка и журнал
// доставок. Секрет на страницу не выводится: только сразу после смены, из ответа на действие.

const DONE = new Set(['saved', 'tested']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'invalid_url', 'not_found', 'endpoint_disabled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_REASONS = new Set(['timeout', 'unreachable', 'blocked_address', 'secret_unreadable', 'endpoint_disabled']);

export default async function WebhookPage({ params, searchParams }: PageProps<'/[locale]/agent/settings/webhooks/[endpointId]'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const { endpointId } = await params;
  const endpoint = await readWebhook(staff, endpointId);
  if (!endpoint) notFound();
  const query = await searchParams;
  const done = firstParam(query.done);
  const error = firstParam(query.error);
  const cursorParam = firstParam(query.cursor);
  const cursor = cursorParam && UUID.test(cursorParam) ? cursorParam : null;
  const t = await getTranslations('agent');
  const w = await getTranslations('agent.settings.webhooks');
  const r = await getTranslations('agent.settings.rules');
  const format = await getFormatter();
  const locale = await getLocale();
  const here = `/agent/settings/webhooks/${endpoint.endpointId}`;
  const reauthHref = `/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}${here}`)}`;
  const [{ labels, events }, log, secret] = await Promise.all([webhookFormProps('edit'), listWebhookDeliveries(staff, { endpointId: endpoint.endpointId, cursor }), secretLabels()]);
  const time = (value: Date) => format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
  /** Причина неудачи словами: код ответа или известный код, иначе общий текст. Тела ответа приёмника портал не хранит. */
  const reason = (code: string | null): string => {
    if (code === null) return '';
    const http = /^http_(\d{3})$/.exec(code);
    if (http) return w('deliveries.errors.http', { status: http[1] ?? '' });
    return w(`deliveries.errors.${KNOWN_REASONS.has(code) ? code : 'unknown'}`);
  };
  const status = (item: DeliveryRecord) => (item.status === 'queued' && item.attempts > 0 ? 'retry' : item.status);
  const tones = { queued: 'gray', retry: 'orange', sent: 'green', failed: 'danger' } as const;
  return (
    <>
      <PageHeader
        title={endpoint.name}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: w('title'), href: '/agent/settings/webhooks' },
          { label: endpoint.name },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('webhooks')}>
        {done && DONE.has(done) && <Alert tone="success">{w(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && (
          <Alert tone="danger">
            {w(`errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={reauthHref} className="font-semibold underline">
                  {w('reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{w('form.editTitle')}</h2>
            <StatusLabel tone={endpoint.isEnabled ? 'green' : 'gray'}>{w(endpoint.isEnabled ? 'states.enabled' : 'states.disabled')}</StatusLabel>
          </CardHeader>
          <CardContent>
            {/* Ключ по времени изменения: после сохранения форма берёт сохранённые значения заново. */}
            <WebhookForm
              key={endpoint.modifiedOn.toISOString()}
              endpointId={endpoint.endpointId}
              defaults={{ name: endpoint.name, url: endpoint.url, events: endpoint.events, isEnabled: endpoint.isEnabled }}
              events={events}
              labels={labels}
              reauthHref={reauthHref}
              endpointHref={`/${locale}/agent/settings/webhooks`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{w('secret.title')}</h2>
          </CardHeader>
          <CardContent>
            <RotateSecret
              endpointId={endpoint.endpointId}
              reauthHref={reauthHref}
              labels={{
                open: w('rotate.open'),
                title: w('rotate.title', { name: endpoint.name }),
                text: w('rotate.text'),
                confirm: w('rotate.confirm'),
                cancel: w('rotate.cancel'),
                close: w('rotate.close'),
                reauth: w('reauth'),
                set: w('secret.set'),
                secret,
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{w('test.title')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3">
            <p className="text-sm text-secondary-foreground">{w('test.text')}</p>
            <form action={sendTestAction}>
              <input type="hidden" name="endpointId" value={endpoint.endpointId} />
              <Button type="submit" variant="secondary" disabled={!endpoint.isEnabled}>
                {w('test.send')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="text-lg font-semibold">{w('deliveries.title')}</h2>
            <p className="text-sm text-secondary-foreground">{w('deliveries.intro')}</p>
            {log.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{w('deliveries.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={w('deliveries.title')}>
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      {(['event', 'ticket', 'status', 'attempts', 'error', 'time'] as const).map((column) => (
                        <th key={column} scope="col" className="px-2 py-2 text-start font-medium">
                          {w(`deliveries.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {log.items.map((item) => (
                      <tr key={item.deliveryId} data-delivery={item.kind} className="border-b border-border align-top last:border-b-0">
                        <td className="px-2 py-2">{item.kind === 'test' ? w('deliveries.testEvent') : r.has(`events.${item.kind}`) ? r(`events.${item.kind}`) : item.kind}</td>
                        <td className="whitespace-nowrap px-2 py-2">
                          {item.ticketNumber === null ? (
                            w('deliveries.noTicket')
                          ) : (
                            <Link href={`/agent/tickets/SUP-${item.ticketNumber}`} className="text-link underline-offset-2 hover:underline">
                              SUP-{item.ticketNumber}
                            </Link>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <StatusLabel tone={tones[status(item)]}>{w(`deliveries.statuses.${status(item)}`)}</StatusLabel>
                        </td>
                        <td className="px-2 py-2 tabular-nums">{item.attempts}</td>
                        <td className="px-2 py-2">{reason(item.lastError)}</td>
                        <td className="whitespace-nowrap px-2 py-2">{time(item.createdOn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              {cursor && (
                <Link href={here} className="text-sm text-link underline-offset-2 hover:underline">
                  {w('deliveries.first')}
                </Link>
              )}
              {log.nextCursor && (
                <Link href={`${here}?cursor=${log.nextCursor}`} className="text-sm text-link underline-offset-2 hover:underline">
                  {w('deliveries.next')}
                </Link>
              )}
            </div>
          </CardContent>
        </Card>

        <ConfirmDelete
          action={deleteWebhookAction}
          field="endpointId"
          value={endpoint.endpointId}
          labels={{ open: w('delete.open'), title: w('delete.title', { name: endpoint.name }), text: w('delete.text'), confirm: w('delete.confirm'), cancel: w('delete.cancel'), close: w('delete.close') }}
        />
      </SettingsLayout>
    </>
  );
}
