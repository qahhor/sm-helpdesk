import { getLocale, getTranslations } from 'next-intl/server';
import { LOCALES } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { listActiveModules } from '@/modules/hdr/api';
import { ALLOWED_FILE_EXTENSIONS, HDT_ERROR_CODES, IMPACTS, MAX_FILES_PER_MESSAGE, PRIORITIES, TICKET_TYPES, VISIBILITIES } from '@/modules/hdt/api';
import { getOrganization, listMembersForStaff, requireStaffActor, searchOrganizations } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { acceptOf } from '@/ui/ticket-status';
import { StaffTicketForm } from './StaffTicketForm';

// Обращение от имени клиента (FR-AG-08): после звонка сотрудник находит организацию, выбирает участника и
// заводит обращение. Клиент увидит, что его создал сотрудник. Роль product обращений не создаёт.

type Search = { q?: string; org?: string; error?: string };

export default async function NewTicketForClientPage({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaffActor({ roles: ['agent_l1', 'agent_l2', 'care', 'admin'] });
  const t = await getTranslations('agent');
  const tc = await getTranslations('client.tickets');
  const params = await searchParams;
  const org = params.org ? await getOrganization(staff, params.org) : null;
  const q = params.q?.trim().slice(0, 100) ?? '';
  const found = !org && q ? await searchOrganizations(staff, { query: q }) : null;
  const members = org ? (await listMembersForStaff(staff, org.orgId)).filter((m) => m.state === 'active') : [];
  const locale = await getLocale();
  const modules = org ? await listActiveModules(staff.actor, locale) : [];
  const error = HDT_ERROR_CODES.find((code) => code === params.error);

  return (
    <>
      <PageHeader
        title={t('newTicket.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('queues.title'), href: '/agent/queues' }, { label: t('newTicket.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex max-w-3xl flex-col gap-4">
        {error && <Alert tone="danger">{t.has(`newTicket.errors.${error}`) ? t(`newTicket.errors.${error}`) : t('newTicket.errors.invalid_input')}</Alert>}
        {!org ? (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <p className="text-secondary-foreground">{t('newTicket.intro')}</p>
              <form className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Label htmlFor="org-search">{t('newTicket.orgSearch')}</Label>
                  <Input id="org-search" name="q" defaultValue={q} maxLength={100} />
                </div>
                <Button type="submit">{t('newTicket.find')}</Button>
              </form>
              {found && found.items.length === 0 && <p className="text-sm text-muted-foreground">{t(found.searchTooShort ? 'orgs.searchTooShort' : 'newTicket.notFound')}</p>}
              {found && found.items.length > 0 && (
                <ul className="flex flex-col gap-1" aria-label={t('newTicket.orgResults')}>
                  {found.items.map((item) => (
                    <li key={item.orgId}>
                      <Link href={`/agent/tickets/new?org=${item.orgId}`} className="text-link underline-offset-2 hover:underline">
                        {item.name}
                      </Link>
                      {item.inn && <span className="text-sm text-muted-foreground"> · {t('ticket.inn', { inn: item.inn })}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{org.name}</span>
                <Link href="/agent/tickets/new" className="text-sm text-link underline-offset-2 hover:underline">
                  {t('newTicket.changeOrg')}
                </Link>
              </p>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('newTicket.noMembers')}</p>
              ) : (
                <StaffTicketForm
                  orgId={org.orgId}
                  members={members.map((m) => ({ value: m.userId, label: m.email ? `${m.name} (${m.email})` : m.name }))}
                  types={TICKET_TYPES.map((value) => ({ value, label: t(`ticket.types.${value}`) }))}
                  impacts={IMPACTS.map((value) => ({ value, label: tc(`impacts.${value}`) }))}
                  priorities={PRIORITIES.map((value) => ({ value, label: value.toUpperCase() }))}
                  modules={modules.map((m) => ({ value: m.moduleId, label: m.name }))}
                  visibilities={VISIBILITIES.map((value) => ({ value, label: tc(`visibilities.${value}`) }))}
                  locales={LOCALES.map((value) => ({ value, label: t(`newTicket.locales.${value}`) }))}
                  defaultLocale={locale}
                  accept={acceptOf(ALLOWED_FILE_EXTENSIONS)}
                  maxFiles={MAX_FILES_PER_MESSAGE}
                  labels={{
                    author: t('newTicket.author'),
                    type: t('newTicket.type'),
                    impact: t('newTicket.impact'),
                    priority: t('newTicket.priority'),
                    priorityByImpact: t('newTicket.priorityByImpact'),
                    title: t('newTicket.subject'),
                    titleHint: t('newTicket.subjectHint'),
                    description: t('newTicket.description'),
                    module: t('newTicket.module'),
                    moduleNone: t('newTicket.moduleNone'),
                    visibility: t('newTicket.visibility'),
                    locale: t('newTicket.locale'),
                    submit: t('newTicket.submit'),
                    busy: tc('files.busy'),
                    files: {
                      add: tc('files.add'),
                      hint: tc('files.hint'),
                      remove: tc.raw('files.remove') as string,
                      uploading: tc.raw('files.uploading') as string,
                      ready: tc('files.ready'),
                      failed: tc('files.failed'),
                      errors: Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, tc(`errors.${code}`)])),
                    },
                  }}
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
