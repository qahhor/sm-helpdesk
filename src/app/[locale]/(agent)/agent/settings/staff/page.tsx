import { getLocale, getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import type { Locale } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { HUMAN_STAFF_ROLES, listStaff, listStaffInvitations, requireStaffActor, type StaffRow } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';
import { changeStaffRoleAction, resetStaffAction, setStaffStateAction } from './actions';
import { InviteStaffForm } from './InviteStaffForm';
import { STAFF_PAGE_ERRORS } from './errors';
import { firstParam } from '@/lib/search-params';
import { Select } from '@/ui/components/select';

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2';
const DONE = new Set(['invited', 'roleChanged', 'blocked', 'unblocked', 'reset']);
const NO_MAIL: Record<string, { done: string; command: string }> = {
  invitedNoMail: { done: 'invited', command: 'hub staff:create --email <email> --name <name> --role <role>' },
  resetNoMail: { done: 'reset', command: 'hub staff:reset --email <email>' },
};

// Сотрудники (FR-ADM-03): список, приглашения, роль, блокировка и сброс доступа.
// Строка открывает карточку сотрудника над таблицей (параметр user): роль, блокировка, сброс доступа.
// Опасные действия (блокировка, сброс) идут через подтверждение: параметр confirm.
export default async function StaffSettingsPage({ searchParams }: PageProps<'/[locale]/agent/settings/staff'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const query = await searchParams;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('agent');
  const ts = await getTranslations('agent.settings.staff');
  const [rows, invitations] = await Promise.all([listStaff(staff), listStaffInvitations(staff)]);

  const error = firstParam(query.error);
  const done = firstParam(query.done);
  const inviting = firstParam(query.invite) === '1';
  const selected = rows.find((row) => row.userId === firstParam(query.user) && !row.isSelf);
  const confirm = firstParam(query.confirm);
  const roles = Object.fromEntries(HUMAN_STAFF_ROLES.map((role) => [role, ts(`roles.${role}`)]));
  const here = `/${locale}/agent/settings/staff`;
  const cancel = (
    <Link href="/agent/settings/staff" className={buttonVariants({ variant: 'secondary' })}>
      {ts('cancel')}
    </Link>
  );
  /** Кнопка, которая открывает карточку или подтверждение: обычный переход с параметрами в адресе. */
  const openWith = (row: StaffRow, params: Record<string, string>, label: string) => (
    <form method="get">
      <input type="hidden" name="user" value={row.userId} />
      {Object.entries(params).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant="secondary" size="small">
        {label}
      </Button>
    </form>
  );

  return (
    <>
      <PageHeader
        title={ts('title')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: ts('title') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          !inviting && (
            <Link href="/agent/settings/staff?invite=1" className={buttonVariants()}>
              {ts('invite')}
            </Link>
          )
        }
      />
      <SettingsLayout {...await settingsNav('staff')}>
        {error && STAFF_PAGE_ERRORS.has(error) && (
          <Alert tone="danger">
            {ts(`errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`} className="font-semibold underline">
                  {ts('reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        {done && DONE.has(done) && <Alert tone="success">{ts(`done.${done}`)}</Alert>}
        {done && NO_MAIL[done] && (
          <Alert tone="info">
            {ts(`done.${NO_MAIL[done].done}`)}. {ts('noMail', { command: NO_MAIL[done].command })}
          </Alert>
        )}

        {inviting && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">{ts('inviteTitle')}</h2>
              <p className="text-sm text-secondary-foreground">{ts('inviteIntro')}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <InviteStaffForm
                labels={{ email: ts('email'), name: ts('name'), role: ts('role'), isLead: ts('isLead'), send: ts('send'), roles }}
              />
              {cancel}
            </CardContent>
          </Card>
        )}

        {selected && (confirm === 'block' || confirm === 'reset') && (
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <h2 className="text-base font-semibold">
                {ts(confirm === 'block' ? 'confirmBlockTitle' : 'confirmResetTitle', { name: selected.name })}
              </h2>
              <p className="text-sm text-secondary-foreground">{ts(confirm === 'block' ? 'confirmBlockText' : 'confirmResetText')}</p>
              <div className="flex flex-wrap gap-2">
                <form action={confirm === 'block' ? setStaffStateAction : resetStaffAction}>
                  <input type="hidden" name="userId" value={selected.userId} />
                  {confirm === 'block' && <input type="hidden" name="state" value="passive" />}
                  <Button type="submit" variant="danger">
                    {ts(confirm === 'block' ? 'confirmBlock' : 'confirmReset')}
                  </Button>
                </form>
                {cancel}
              </div>
            </CardContent>
          </Card>
        )}

        {selected && !confirm && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">{ts('editTitle', { name: selected.name })}</h2>
              <p className="text-sm text-secondary-foreground wrap-anywhere">{selected.email}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <form action={changeStaffRoleAction} className="flex flex-col gap-4">
                <input type="hidden" name="userId" value={selected.userId} />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="field-staff-role">{ts('role')}</Label>
                  <Select
                    id="field-staff-role"
                    name="role"
                    defaultValue={selected.role}
                   
                  >
                    {HUMAN_STAFF_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {roles[role]}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className="inline-flex min-h-control items-center gap-3">
                  <input type="checkbox" name="isLead" defaultChecked={selected.isLead} className="size-5 shrink-0 accent-primary" />
                  {ts('isLead')}
                </label>
                <Button type="submit" className="self-start">
                  {ts('save')}
                </Button>
              </form>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {selected.state === 'active' ? (
                  openWith(selected, { confirm: 'block' }, ts('block'))
                ) : (
                  <form action={setStaffStateAction}>
                    <input type="hidden" name="userId" value={selected.userId} />
                    <input type="hidden" name="state" value="active" />
                    <Button type="submit" variant="secondary" size="small">
                      {ts('unblock')}
                    </Button>
                  </form>
                )}
                {openWith(selected, { confirm: 'reset' }, ts('reset'))}
                <Link href="/agent/settings/staff" className={buttonVariants({ variant: 'ghost', size: 'small' })}>
                  {ts('close')}
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={head}>{ts('columns.name')}</th>
                <th scope="col" className={head}>{ts('columns.email')}</th>
                <th scope="col" className={head}>{ts('columns.role')}</th>
                <th scope="col" className={head}>{ts('columns.secondFactor')}</th>
                <th scope="col" className={head}>{ts('columns.state')}</th>
                <th scope="col" className={head}>
                  <span className="sr-only">{ts('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className="h-row border-b border-border last:border-b-0">
                  <td className={`${cell} font-medium`}>
                    {row.name}
                    {row.isSelf && <span className="ms-2 text-xs font-normal text-secondary-foreground">{ts('self')}</span>}
                  </td>
                  <td className={`${cell} wrap-anywhere`}>{row.email}</td>
                  <td className={cell}>
                    {roles[row.role] ?? row.role}
                    {row.isLead && <span className="block text-xs text-secondary-foreground">{ts('lead')}</span>}
                  </td>
                  <td className={cell}>{ts(`secondFactor.${row.hasSecondFactor ? 'on' : 'off'}`)}</td>
                  <td className={cell}>
                    <StatusLabel tone={row.state === 'active' ? 'green' : 'gray'}>{ts(`states.${row.state}`)}</StatusLabel>
                  </td>
                  <td className={cell}>
                    {!row.isSelf && <div className="flex justify-end">{openWith(row, {}, ts('manage'))}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card className="overflow-x-auto">
          <CardHeader>
            <h2 className="text-base font-semibold">{ts('invitationsTitle')}</h2>
          </CardHeader>
          {invitations.length === 0 ? (
            <CardContent>
              <p className="text-sm text-secondary-foreground">{ts('noInvitations')}</p>
            </CardContent>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{ts('invitationColumns.email')}</th>
                  <th scope="col" className={head}>{ts('invitationColumns.role')}</th>
                  <th scope="col" className={head}>{ts('invitationColumns.expiresOn')}</th>
                  <th scope="col" className={head}>{ts('invitationColumns.state')}</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.invitationId} className="h-row border-b border-border last:border-b-0">
                    <td className={`${cell} wrap-anywhere`}>{invitation.email}</td>
                    <td className={cell}>{roles[invitation.role]}</td>
                    <td className={cell}>{formatDateTime(invitation.expiresOn, locale)}</td>
                    <td className={cell}>
                      <StatusLabel tone="orange">{ts('waiting')}</StatusLabel>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </SettingsLayout>
    </>
  );
}
