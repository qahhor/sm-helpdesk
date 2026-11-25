import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import type { Locale } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { getServer, requireStaffActor, serverCallbackUrl, widgetSnippet } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../../sections';
import { checkServerAction, disableServerAction, enableServerAction } from '../actions';
import { serverFormLabels, widgetFormLabels } from '../form-labels';
import { ServerForm } from '../ServerForm';
import { WidgetForm } from '../WidgetForm';
import { firstParam } from '@/lib/search-params';

const ERRORS = new Set(['invalid_input', 'server_taken', 'stale_session', 'forbidden', 'not_found']);
const DONE = new Set(['added', 'saved', 'disabled', 'enabled']);

// Карточка сервера Smartup (FR-ADM-01): сведения, адрес возврата, проверка связи, изменение, отключение.
// Секрет на страницу не выводится никогда: только пометка, что он задан.
export default async function ServerPage({ params, searchParams }: PageProps<'/[locale]/agent/settings/servers/[code]'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const { code } = await params;
  const server = await getServer(staff.actor, code);
  if (!server) notFound();
  const query = await searchParams;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('agent');
  const ts = await getTranslations('agent.settings.servers');
  const error = firstParam(query.error);
  const done = firstParam(query.done);
  const confirming = firstParam(query.confirm) === 'disable' && server.state === 'active';
  const here = `/${locale}/agent/settings/servers/${server.code}`;
  const reauthHref = `/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`;
  const endpoints = server.endpoints ?? { authorization: '', token: '', userinfo: '', jwks: '' };

  return (
    <>
      <PageHeader
        title={server.name}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: ts('title'), href: '/agent/settings/servers' },
          { label: server.code },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('servers')}>
        {error && ERRORS.has(error) && (
          <Alert tone="danger">
            {ts(`errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={reauthHref} className="font-semibold underline">
                  {ts('reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        {done && DONE.has(done) && <Alert tone="success">{ts(`done.${done}`)}</Alert>}
        {done === 'checked' && server.lastCheck?.ok && <Alert tone="success">{ts('checkOk')}</Alert>}
        {done === 'checked' && server.lastCheck && !server.lastCheck.ok && (
          <Alert tone="danger">
            {ts('checkFailed')}
            <ul className="mt-1 list-disc ps-5">
              {server.lastCheck.issues.map((issue) => (
                <li key={issue}>{ts(`issues.${issue}`)}</li>
              ))}
            </ul>
          </Alert>
        )}

        {confirming && (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <h2 className="text-base font-semibold">{ts('confirmTitle', { name: server.name })}</h2>
              <p className="text-sm text-secondary-foreground">{ts('confirmText')}</p>
              <div className="flex flex-wrap gap-2">
                <form action={disableServerAction}>
                  <input type="hidden" name="code" value={server.code} />
                  <Button type="submit" variant="danger">
                    {ts('confirm')}
                  </Button>
                </form>
                <Link href={`/agent/settings/servers/${server.code}`} className={buttonVariants({ variant: 'secondary' })}>
                  {ts('cancel')}
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('details')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm tablet:grid-cols-[max-content_1fr]">
              <dt className="text-secondary-foreground">{ts('code')}</dt>
              <dd className="font-medium">{server.code}</dd>
              <dt className="text-secondary-foreground">{ts('state')}</dt>
              <dd>
                <StatusLabel tone={server.state === 'active' ? 'green' : 'gray'}>{ts(`states.${server.state}`)}</StatusLabel>
              </dd>
              <dt className="text-secondary-foreground">{ts('isDefault')}</dt>
              <dd>{server.isDefault ? ts('yes') : ts('no')}</dd>
              <dt className="text-secondary-foreground">{ts('fields.clientSecret')}</dt>
              <dd>{ts('secretSet')}</dd>
              <dt className="text-secondary-foreground">{ts('callback')}</dt>
              <dd className="flex flex-col gap-1">
                <code className="wrap-anywhere rounded-control bg-card-soft px-2 py-1">{serverCallbackUrl(server.code)}</code>
                <span className="text-secondary-foreground">{ts('callbackHint')}</span>
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('checkTitle')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3">
            <p className="text-sm text-secondary-foreground">
              {server.lastCheck ? ts('checkedOn', { time: formatDateTime(server.lastCheck.checkedOn, locale) }) : ts('checkNever')}{' '}
              {server.lastCheck && ts(`check.${server.lastCheck.ok ? 'ok' : 'fail'}`)}
            </p>
            <form action={checkServerAction}>
              <input type="hidden" name="code" value={server.code} />
              <Button type="submit" variant="secondary">
                {ts('checkButton')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('formTitle')}</h2>
          </CardHeader>
          <CardContent>
            <ServerForm
              mode="edit"
              defaults={{
                code: server.code,
                name: server.name,
                baseUrl: server.baseUrl,
                issuer: server.issuer,
                clientId: server.clientId,
                isDefault: server.isDefault ? 'on' : '',
                roleMap: Object.entries(server.roleMap)
                  .map(([role, portalRole]) => `${role} = ${portalRole}`)
                  .join('\n'),
                ...endpoints,
              }}
              labels={await serverFormLabels('edit')}
              reauthHref={reauthHref}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('widget.title')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-secondary-foreground">{ts('widget.intro')}</p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm tablet:grid-cols-[max-content_1fr]">
              <dt className="text-secondary-foreground">{ts('widget.embedKey')}</dt>
              <dd className="flex flex-col gap-1">
                <code className="wrap-anywhere rounded-control bg-card-soft px-2 py-1" data-testid="embed-key">
                  {server.widget.embedKey}
                </code>
                <span className="text-secondary-foreground">{ts('widget.embedKeyHint')}</span>
              </dd>
              <dt className="text-secondary-foreground">{ts('widget.contextIssuer')}</dt>
              <dd className="wrap-anywhere">{server.widget.contextIssuer}</dd>
              <dt className="text-secondary-foreground">{ts('widget.audience')}</dt>
              <dd>smartup-hub</dd>
              <dt className="text-secondary-foreground">{ts('widget.lifetime')}</dt>
              <dd>{ts('widget.lifetimeValue')}</dd>
              <dt className="text-secondary-foreground">{ts('widget.snippet')}</dt>
              <dd>
                <pre className="overflow-x-auto rounded-control bg-card-soft px-2 py-1 text-sm">
                  <code>{widgetSnippet(server.widget.embedKey)}</code>
                </pre>
              </dd>
            </dl>
            <WidgetForm
              code={server.code}
              hasSecret={server.widget.hasContextSecret}
              defaults={{
                mode: server.widget.contextKeyMode ?? '',
                contextIssuer: server.widget.contextIssuer,
                jwksUrl: server.widget.contextJwksUrl ?? '',
                embedOrigins: server.widget.embedOrigins.join('\n'),
              }}
              labels={await widgetFormLabels()}
              reauthHref={reauthHref}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('stateTitle')}</h2>
          </CardHeader>
          <CardContent>
            {server.state === 'active' ? (
              !confirming && (
                <Link href={`/agent/settings/servers/${server.code}?confirm=disable`} className={buttonVariants({ variant: 'secondary' })}>
                  {ts('disable')}
                </Link>
              )
            ) : (
              <form action={enableServerAction}>
                <input type="hidden" name="code" value={server.code} />
                <Button type="submit" variant="secondary">
                  {ts('enable')}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
