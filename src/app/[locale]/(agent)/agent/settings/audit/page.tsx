import { getLocale, getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import { type Locale, TIME_ZONE } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { AUDIT_ACTIONS, isHdcError } from '@/modules/hdc/api';
import { listAuditNamed, requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../sections';
import { firstParam } from '@/lib/search-params';
import { diffLines } from './diff';
import { Select } from '@/ui/components/select';

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2 align-top';
const OBJECT_TYPES = ['staff', 'server', 'membership', 'invitation', 'user', 'session', 'organization', 'ticket', 'attachment', 'module', 'sla_policy', 'business_calendar', 'rule', 'webhook'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата из поля формы как начало или конец дня в часовом поясе портала. */
function dayBoundary(date: string | undefined, end: boolean): string | undefined {
  if (!date || !DATE.test(date)) return undefined;
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  const offset = zone && zone !== 'GMT' ? zone.replace('GMT', '') : 'Z';
  return `${date}T${end ? '23:59:59.999' : '00:00:00'}${offset}`;
}

/** Дата семь дней назад для поля "С": так видно, какой период показан по умолчанию. */
function weekAgo(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() - 7 * 86400e3));
}

// Журнал аудита (FR-ADM-07): только admin, от новых к старым, по 50 строк. Кнопок изменения и удаления нет:
// прав на них нет ни у одной роли приложения. Отбор по автору и организации ставится ссылкой из строки.
export default async function AuditPage({ searchParams }: PageProps<'/[locale]/agent/settings/audit'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const query = await searchParams;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('agent');
  const ta = await getTranslations('agent.settings.audit');
  // Поля и коды значений словами интерфейса; неизвестное как есть (проверка main, Q14).
  const word = (raw: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && ta.has(`words.${raw}`) ? ta(`words.${raw}`) : raw);

  const filters = {
    from: firstParam(query.from) ?? weekAgo(),
    to: firstParam(query.to) ?? '',
    action: firstParam(query.action) ?? '',
    type: firstParam(query.type) ?? '',
    actor: firstParam(query.actor) ?? '',
    org: firstParam(query.org) ?? '',
  };
  const cursor = firstParam(query.cursor);
  let page: Awaited<ReturnType<typeof listAuditNamed>> | null = null;
  try {
    page = await listAuditNamed(staff, {
      from: dayBoundary(filters.from, false),
      to: dayBoundary(filters.to, true),
      action: filters.action || undefined,
      objectType: filters.type || undefined,
      actorId: filters.actor || undefined,
      orgId: filters.org || undefined,
      cursor,
    });
  } catch (error) {
    if (!isHdcError(error) || error.code !== 'invalid_input') throw error;
  }
  /** Адрес журнала с текущими фильтрами и изменениями. */
  const hrefWith = (changes: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...filters, ...changes })) if (value) params.set(key, value);
    return `/agent/settings/audit?${params}`;
  };
  const actorFilterName = filters.actor ? page?.items.find((row) => row.actorId === filters.actor)?.actorName ?? filters.actor : null;
  const orgFilterName = filters.org ? page?.items.find((row) => row.orgId === filters.org)?.orgName ?? filters.org : null;

  return (
    <>
      <PageHeader
        title={ta('title')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: ta('title') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('audit')}>
        <p className="text-secondary-foreground">{ta('intro')}</p>
        <form method="get" className="grid grid-cols-1 items-end gap-3 tablet:grid-cols-2 desktop:grid-cols-4">
          {filters.actor && <input type="hidden" name="actor" value={filters.actor} />}
          {filters.org && <input type="hidden" name="org" value={filters.org} />}
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-from">{ta('from')}</Label>
            <Input id="audit-from" type="date" name="from" defaultValue={filters.from} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-to">{ta('to')}</Label>
            <Input id="audit-to" type="date" name="to" defaultValue={filters.to} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-action">{ta('action')}</Label>
            <Select id="audit-action" name="action" defaultValue={filters.action}>
              <option value="">{ta('allActions')}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ta(`actions.${action}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-type">{ta('objectType')}</Label>
            <Select id="audit-type" name="type" defaultValue={filters.type}>
              <option value="">{ta('allTypes')}</option>
              {OBJECT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ta(`objectTypes.${type}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap gap-2 tablet:col-span-2 desktop:col-span-4">
            <Button type="submit">{ta('show')}</Button>
            <Link href="/agent/settings/audit" className={buttonVariants({ variant: 'secondary' })}>
              {ta('reset')}
            </Link>
          </div>
        </form>

        {(actorFilterName || orgFilterName) && (
          <div className="flex flex-wrap gap-3 text-sm">
            {actorFilterName && (
              <span>
                {ta('filteredBy', { name: actorFilterName })}{' '}
                <Link href={hrefWith({ actor: undefined })} className="font-medium text-link underline-offset-2 hover:underline">
                  {ta('clear')}
                </Link>
              </span>
            )}
            {orgFilterName && (
              <span>
                {ta('filteredBy', { name: orgFilterName })}{' '}
                <Link href={hrefWith({ org: undefined })} className="font-medium text-link underline-offset-2 hover:underline">
                  {ta('clear')}
                </Link>
              </span>
            )}
          </div>
        )}

        {!page ? (
          <Alert tone="danger">{ta('invalid')}</Alert>
        ) : page.items.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-secondary-foreground">{ta('empty')}</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{ta('columns.time')}</th>
                  <th scope="col" className={head}>{ta('columns.actor')}</th>
                  <th scope="col" className={head}>{ta('columns.action')}</th>
                  <th scope="col" className={head}>{ta('columns.object')}</th>
                  <th scope="col" className={head}>{ta('columns.org')}</th>
                  <th scope="col" className={head}>{ta('columns.changes')}</th>
                  <th scope="col" className={head}>{ta('columns.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={row.auditId} className="border-b border-border last:border-b-0">
                    <td className={`${cell} whitespace-nowrap`}>{formatDateTime(row.createdOn, locale)}</td>
                    <td className={cell}>
                      {row.actorId ? (
                        <Link href={hrefWith({ actor: row.actorId, cursor: undefined })} className="text-link underline-offset-2 hover:underline">
                          {row.actorName ?? row.actorId}
                        </Link>
                      ) : (
                        ta(`actorTypes.${row.actorType === 'agent' ? 'agent' : 'system'}`)
                      )}
                      {row.actorId && <span className="block text-xs text-secondary-foreground">{ta(`actorTypes.${row.actorType === 'client' ? 'client' : 'staff'}`)}</span>}
                    </td>
                    <td className={cell}>
                      {ta(`actions.${row.action}`)}
                      <span className="block text-xs text-secondary-foreground">{row.action}</span>
                    </td>
                    <td className={`${cell} wrap-anywhere`}>
                      {(OBJECT_TYPES as readonly string[]).includes(row.objectType) ? ta(`objectTypes.${row.objectType}`) : row.objectType}
                      {row.objectId && <span className="block text-xs text-secondary-foreground">{row.objectId}</span>}
                    </td>
                    <td className={cell}>
                      {row.orgId ? (
                        <Link href={hrefWith({ org: row.orgId, cursor: undefined })} className="text-link underline-offset-2 hover:underline">
                          {row.orgName ?? row.orgId}
                        </Link>
                      ) : (
                        ta('none')
                      )}
                    </td>
                    <td className={`${cell} wrap-anywhere`}>
                      {diffLines(row.diff, word, ta('none')).map((line) => (
                        <span key={line} className="block">
                          {line}
                        </span>
                      ))}
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>{row.ip ?? ta('none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {page && (cursor || page.nextCursor) && (
          <nav aria-label={ta('title')} className="flex flex-wrap gap-2">
            {cursor && (
              <Link href={hrefWith({})} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
                {ta('first')}
              </Link>
            )}
            {page.nextCursor && (
              <Link href={hrefWith({ cursor: page.nextCursor })} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
                {ta('next')}
              </Link>
            )}
          </nav>
        )}
      </SettingsLayout>
    </>
  );
}
