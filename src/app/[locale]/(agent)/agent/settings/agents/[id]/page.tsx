import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { agentToolCalls, readAgentToken } from '@/modules/hda/api/agent-admin';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { ConfirmDelete } from '../../ConfirmDelete';
import { settingsNav } from '../../sections';
import { eventParentAction, revokeTokenAction } from '../actions';
import { tokenFormProps } from '../form-labels';
import { TokenForm } from '../TokenForm';
import { STATE_TONES } from '../TokenList';

// Токен AI-сотрудника (экран 8.12; план M8b, задача 3, решения 27-29): перечень инструментов, адреса, предел и срок,
// отметка "для событий", отзыв одним действием с подтверждением и журнал вызовов страницами по 50. Журнал без
// аргументов и ответов: время, инструмент, итог, объекты, длительность.

const DONE = new Set(['saved', 'revoked', 'eventParentSet', 'eventParentCleared']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_TONES = { ok: 'green', refused: 'danger', invalid: 'orange', rate_limited: 'orange', error: 'danger' } as const;

export default async function AgentTokenPage({ params, searchParams }: PageProps<'/[locale]/agent/settings/agents/[id]'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const { id } = await params;
  const token = await readAgentToken(staff, id);
  if (!token) notFound();
  const query = await searchParams;
  const done = firstParam(query.done);
  const error = firstParam(query.error);
  const cursorParam = firstParam(query.cursor);
  const cursor = cursorParam && UUID.test(cursorParam) ? cursorParam : null;
  const t = await getTranslations('agent');
  const a = await getTranslations('agent.settings.agents');
  const format = await getFormatter();
  const locale = await getLocale();
  const here = `/agent/settings/agents/${token.tokenId}`;
  const reauthHref = `/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}${here}`)}`;
  const [form, log] = await Promise.all([tokenFormProps('edit'), agentToolCalls(staff, { tokenId: token.tokenId, cursor })]);
  const time = (value: Date) => format.dateTime(value, { dateStyle: 'medium', timeStyle: 'medium' });
  const revoked = token.state === 'revoked';
  return (
    <>
      <PageHeader
        title={token.name}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: a('title'), href: '/agent/settings/agents' },
          { label: token.name },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('agents')}>
        {done && DONE.has(done) && <Alert tone="success">{a(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && (
          <Alert tone="danger">
            {a(`errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={reauthHref} className="font-semibold underline">
                  {a('reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        <Card>
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusLabel tone={STATE_TONES[token.state]}>{a(`states.${token.state}`)}</StatusLabel>
              <span className="text-muted-foreground">{a('last4', { last4: token.last4 })}</span>
            </div>
            <dl className="grid gap-x-6 gap-y-1 tablet:grid-cols-[max-content_1fr]">
              <dt className="text-muted-foreground">{a('columns.expiresAt')}</dt>
              <dd>{format.dateTime(token.expiresAt, { dateStyle: 'long' })}</dd>
              <dt className="text-muted-foreground">{a('columns.lastUsedAt')}</dt>
              <dd>{token.lastUsedAt ? time(token.lastUsedAt) : a('never')}</dd>
              <dt className="text-muted-foreground">{a('columns.calls')}</dt>
              <dd className="tabular-nums">{a('callsOf', { calls: token.callsToday, limit: token.dailyLimit })}</dd>
              {token.revokedAt && (
                <>
                  <dt className="text-muted-foreground">{a('revokedAt')}</dt>
                  <dd>{time(token.revokedAt)}</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        {!revoked && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">{a('form.editTitle')}</h2>
            </CardHeader>
            <CardContent>
              {/* Ключ по времени изменения: после сохранения форма берёт сохранённые значения заново. */}
              <TokenForm
                key={token.modifiedOn.toISOString()}
                tokenId={token.tokenId}
                defaults={{ name: token.name, tools: token.tools, allowedIps: token.allowedIps.join('\n'), expiresAt: token.expiresAt.toISOString().slice(0, 10), dailyLimit: String(token.dailyLimit) }}
                readTools={form.readTools}
                writeTools={form.writeTools}
                labels={form.labels}
                reauthHref={reauthHref}
                tokenHref={`/${locale}/agent/settings/agents`}
              />
            </CardContent>
          </Card>
        )}

        {token.state === 'active' && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">{a('eventParent.title')}</h2>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3">
              <p className="text-sm text-secondary-foreground">{a(token.isEventParent ? 'eventParent.on' : 'eventParent.off')}</p>
              <form action={eventParentAction}>
                <input type="hidden" name="tokenId" value={token.tokenId} />
                {token.isEventParent && <input type="hidden" name="clear" value="1" />}
                <Button type="submit" variant="secondary">
                  {a(token.isEventParent ? 'eventParent.clear' : 'eventParent.set')}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="text-lg font-semibold">{a('calls.title')}</h2>
            <p className="text-sm text-secondary-foreground">{a('calls.intro')}</p>
            {log.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{a('calls.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={a('calls.title')}>
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      {(['time', 'tool', 'status', 'objects', 'duration'] as const).map((column) => (
                        <th key={column} scope="col" className="px-2 py-2 text-start font-medium">
                          {a(`calls.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {log.items.map((item) => (
                      <tr key={item.callId} data-agent-call={item.tool} className="border-b border-border align-top last:border-b-0">
                        <td className="whitespace-nowrap px-2 py-2">{time(item.createdOn)}</td>
                        <td className="px-2 py-2">
                          <code className="wrap-anywhere font-mono">{item.tool}</code>
                          {item.isRun && <span className="block text-muted-foreground">{a('calls.run')}</span>}
                        </td>
                        <td className="px-2 py-2">
                          <StatusLabel tone={STATUS_TONES[item.status]}>{a(`calls.statuses.${item.status}`)}</StatusLabel>
                        </td>
                        <td className="wrap-anywhere px-2 py-2">
                          {item.objectRefs.length === 0
                            ? a('calls.noObjects')
                            : item.objectRefs.map((ref, index) => (
                                <span key={`${ref.kind}-${String(ref.ref)}`}>
                                  {index > 0 && ', '}
                                  {ref.kind === 'ticket' ? (
                                    <Link href={`/agent/tickets/SUP-${String(ref.ref)}`} className="text-link underline-offset-2 hover:underline">
                                      SUP-{String(ref.ref)}
                                    </Link>
                                  ) : (
                                    a(`calls.refs.${ref.kind}`, { ref: String(ref.ref) })
                                  )}
                                </span>
                              ))}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{a('calls.ms', { ms: item.durationMs })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              {cursor && (
                <Link href={here} className="text-sm text-link underline-offset-2 hover:underline">
                  {a('calls.first')}
                </Link>
              )}
              {log.nextCursor && (
                <Link href={`${here}?cursor=${log.nextCursor}`} className="text-sm text-link underline-offset-2 hover:underline">
                  {a('calls.next')}
                </Link>
              )}
            </div>
          </CardContent>
        </Card>

        {!revoked && (
          <ConfirmDelete
            action={revokeTokenAction}
            field="tokenId"
            value={token.tokenId}
            labels={{ open: a('revoke.open'), title: a('revoke.title', { name: token.name }), text: a('revoke.text'), confirm: a('revoke.confirm'), cancel: a('revoke.cancel'), close: a('revoke.close') }}
          />
        )}
      </SettingsLayout>
    </>
  );
}
