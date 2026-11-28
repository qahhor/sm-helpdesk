import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getOrganization, listInvitations, memberForStaff, pageMembersForStaff, listOrgDomains, requireStaffActor } from '@/modules/hdu/api';
import { EmailDomains } from './EmailDomains';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { PageHeader } from '@/ui/components/PageHeader';
import { Label } from '@/ui/components/label';
import { anonymizeMemberAction, changeRoleAction, inviteStaffAction, revokeStaffAction, setContractEndAction, setMemberStateStaffAction, setOrgAiAction, setPilotAction, updateOrgSettingsAction } from './actions';
import { canSeePilot, isPilotOrg } from '@/modules/hdt/api';
import { Input } from '@/ui/components/input';
import { firstParam } from '@/lib/search-params';
import { Select } from '@/ui/components/select';

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3';
const ERRORS = new Set(['stale_session', 'forbidden', 'not_found', 'invalid_input', 'already_member', 'rate_limited']);
const DONE = new Set(['roleChanged', 'disabled', 'enabled', 'invited', 'revoked', 'settingsSaved', 'aiEnabled', 'aiDisabled', 'pilotOn', 'pilotOff', 'contractSaved', 'contractCleared', 'anonymized']);
/** Итог действий с доменами почты: свои тексты в orgs.domains. */
const DOMAIN_ERRORS = new Set(['invalid_input', 'domain_taken', 'forbidden']);
const DOMAIN_DONE = { domainAdded: 'added', domainRemoved: 'removed' } as const;

// Карточка организации в рабочем месте (FR-ID-13, FR-ADM-02). Участники видны всем сотрудникам-людям,
// управляют ролями, участниками и приглашениями care и admin. Неверный или неизвестный адрес: 404.
export default async function OrganizationPage({ params, searchParams }: PageProps<'/[locale]/agent/organizations/[orgId]'>) {
  const staff = await requireStaffActor();
  const { orgId } = await params;
  const org = await getOrganization(staff, orgId);
  if (!org) notFound();
  const canManage = staff.actor.staffRole === 'care' || staff.actor.staffRole === 'admin';
  const query = await searchParams;
  // Участники страницами по ключу с поиском по имени (проверка качества, Q20; проверка интерфейса, U8). Негодный ключ
  // из адреса показывает первую страницу.
  const memberQuery = firstParam(query.mq)?.trim().slice(0, 100) ?? '';
  const memberAfter = firstParam(query.after) ?? null;
  const [{ members, next: membersNext }, invitations, domains] = await Promise.all([
    pageMembersForStaff(staff, org.orgId, { q: memberQuery, after: memberAfter }).catch(() => pageMembersForStaff(staff, org.orgId, { q: memberQuery })),
    canManage ? listInvitations({ ctx: staff, orgId: org.orgId }) : Promise.resolve([]),
    listOrgDomains(staff, org.orgId),
  ]);
  // Отметка пилота (план M9, решение 11): видят care и администратор, меняет администратор.
  const pilot = canSeePilot(staff) ? await isPilotOrg(staff, org.orgId) : null;
  const error = firstParam(query.error);
  const done = firstParam(query.done);
  // Участник окна подтверждения читается по идентификатору: он может быть не на показанной странице.
  const confirmId = firstParam(query.confirm);
  const confirmMember = canManage && confirmId ? await memberForStaff(staff, org.orgId, confirmId) : null;
  const confirming = confirmMember?.state === 'active' ? confirmMember : null;
  const isAdmin = staff.actor.staffRole === 'admin';
  // Обезличивание по запросу (ТЗ 14.6): только администратор, сначала подтверждение.
  const anonymizeId = firstParam(query.anonymize);
  const anonymizing = isAdmin && anonymizeId ? await memberForStaff(staff, org.orgId, anonymizeId) : null;
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const locale = await getLocale();
  const here = `/${locale}/agent/organizations/${org.orgId}`;

  return (
    <>
      <PageHeader
        title={org.name}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('orgs.title'), href: '/agent/organizations' }, { label: org.name }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm tablet:grid-cols-4">
        <dt className="text-secondary-foreground">{t('orgs.inn')}</dt>
        <dd>{org.inn ?? t('orgs.none')}</dd>
        <dt className="text-secondary-foreground">{t('orgs.server')}</dt>
        <dd>{org.serverName}</dd>
        <dt className="text-secondary-foreground">{t('orgs.category')}</dt>
        <dd>{org.category ?? t('orgs.none')}</dd>
        <dt className="text-secondary-foreground">{t('orgs.state')}</dt>
        <dd>{t(`orgs.states.${org.state}`)}</dd>
        <dt className="text-secondary-foreground">{t('orgs.ai')}</dt>
        <dd>{t(org.isAiEnabled ? 'orgs.aiOn' : 'orgs.aiOff')}</dd>
      </dl>
      <p className="text-sm text-secondary-foreground" data-testid="org-ai-consent">
        {org.aiConsentOn && org.aiConsentRef
          ? t('orgs.aiConsent', { date: format.dateTime(new Date(`${org.aiConsentOn}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }), ref: org.aiConsentRef })
          : t('orgs.aiConsentNone')}
      </p>
      {staff.actor.staffRole === 'admin' && (
        <Link href={`/agent/settings/audit?org=${org.orgId}`} className="self-start text-sm font-medium text-link underline-offset-2 hover:underline">
          {t('orgs.auditLink')}
        </Link>
      )}

      {error && DOMAIN_ERRORS.has(error) && query.domain !== undefined && <Alert tone="danger">{t(`orgs.domains.errors.${error}`)}</Alert>}
      {done && done in DOMAIN_DONE && <Alert tone="success">{t(`orgs.domains.done.${DOMAIN_DONE[done as keyof typeof DOMAIN_DONE]}`)}</Alert>}
      {error && ERRORS.has(error) && query.domain === undefined && (
        <Alert tone="danger">
          {t(`orgs.errors.${error}`)}
          {error === 'stale_session' && (
            <>
              {' '}
              <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`} className="font-semibold underline">
                {t('orgs.reauth')}
              </a>
            </>
          )}
        </Alert>
      )}
      {done && DONE.has(done) && <Alert tone="success">{t(`orgs.done.${done}`)}</Alert>}

      {anonymizing && (
        <Card data-testid="anonymize-confirm">
          <CardContent className="flex flex-col gap-3 pt-6">
            <h2 className="text-base font-semibold">{t('orgs.anonymize.confirmTitle', { name: anonymizing.name })}</h2>
            <p className="text-sm text-secondary-foreground">{t('orgs.anonymize.confirmText')}</p>
            <div className="flex gap-2">
              <form action={anonymizeMemberAction}>
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="userId" value={anonymizing.userId} />
                <Button type="submit" variant="danger">
                  {t('orgs.anonymize.confirm')}
                </Button>
              </form>
              <Link href={`/agent/organizations/${org.orgId}`} className={buttonVariants({ variant: 'secondary' })}>
                {t('orgs.cancel')}
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && confirming && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <h2 className="text-base font-semibold">{t('orgs.confirmTitle', { name: confirming.name })}</h2>
            <p className="text-sm text-secondary-foreground">{t('orgs.confirmText')}</p>
            <div className="flex gap-2">
              <form action={setMemberStateStaffAction}>
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="userId" value={confirming.userId} />
                <input type="hidden" name="state" value="passive" />
                <Button type="submit" variant="danger">
                  {t('orgs.confirm')}
                </Button>
              </form>
              <Link href={`/agent/organizations/${org.orgId}`} className={buttonVariants({ variant: 'secondary' })}>
                {t('orgs.cancel')}
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{t('orgs.settingsTitle')}</h2>
          </CardHeader>
          <CardContent>
            <form action={updateOrgSettingsAction} className="flex flex-col gap-4">
              <input type="hidden" name="orgId" value={org.orgId} />
              <div className="flex max-w-md flex-col gap-1">
                <Label htmlFor="field-category">{t('orgs.categoryLabel')}</Label>
                <Select
                  id="field-category"
                  name="category"
                  defaultValue={org.category ?? ''}
                 
                >
                  <option value="">{t('orgs.categoryNone')}</option>
                  {(['A', 'B', 'C', 'D'] as const).map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" className="self-start">
                {t('orgs.saveSettings')}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{t('orgs.ai')}</h2>
          </CardHeader>
          <CardContent>
            {org.isAiEnabled ? (
              <form action={setOrgAiAction} className="flex flex-col gap-3">
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="enabled" value="false" />
                <p id="org-ai-hint" className="text-sm text-secondary-foreground">
                  {t('orgs.aiHint')}
                </p>
                <Button type="submit" variant="secondary" className="self-start" aria-describedby="org-ai-hint">
                  {t('orgs.aiDisable')}
                </Button>
              </form>
            ) : (
              <form action={setOrgAiAction} className="flex flex-col gap-4">
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="enabled" value="true" />
                <p className="text-sm text-secondary-foreground">{t('orgs.aiEnableHint')}</p>
                <div className="grid max-w-xl gap-4 tablet:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="field-consent-on">{t('orgs.aiConsentOn')}</Label>
                    <Input id="field-consent-on" name="consentOn" type="date" required />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="field-consent-ref">{t('orgs.aiConsentRef')}</Label>
                    <Input id="field-consent-ref" name="consentRef" required maxLength={200} aria-describedby="field-consent-ref-hint" />
                    <p id="field-consent-ref-hint" className="text-sm text-secondary-foreground">
                      {t('orgs.aiConsentRefHint')}
                    </p>
                  </div>
                </div>
                <Button type="submit" className="self-start">
                  {t('orgs.aiEnable')}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {pilot !== null && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{t('orgs.pilot.title')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-secondary-foreground" data-testid="org-pilot">
              {t(pilot ? 'orgs.pilot.on' : 'orgs.pilot.off')}
            </p>
            {staff.actor.staffRole === 'admin' && (
              <form action={setPilotAction}>
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="pilot" value={pilot ? 'false' : 'true'} />
                <Button type="submit" variant="secondary">
                  {t(pilot ? 'orgs.pilot.unmark' : 'orgs.pilot.mark')}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* Дата окончания договора (ТЗ 14.6; волна 7, T2): видят care и admin, задаёт только администратор. */}
      {canManage && (
        <Card data-testid="org-contract">
          <CardHeader>
            <h2 className="text-base font-semibold">{t('orgs.contract.title')}</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-secondary-foreground" data-testid="org-contract-end">
              {org.contractEndsOn
                ? t('orgs.contract.endsOn', { date: format.dateTime(new Date(`${org.contractEndsOn}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) })
                : t('orgs.contract.none')}
            </p>
            <p className="text-sm text-secondary-foreground">{t('orgs.contract.hint')}</p>
            {isAdmin && (
              <form action={setContractEndAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="orgId" value={org.orgId} />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="field-contract-end">{t('orgs.contract.label')}</Label>
                  <Input id="field-contract-end" name="contractEndsOn" type="date" min="2000-01-01" max="2100-12-31" defaultValue={org.contractEndsOn ?? ''} />
                </div>
                <Button type="submit" variant="secondary">
                  {t('orgs.contract.save')}
                </Button>
                {org.contractEndsOn && (
                  <Button type="submit" name="clear" value="1" variant="ghost">
                    {t('orgs.contract.clear')}
                  </Button>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <EmailDomains orgId={org.orgId} domains={domains} canManage={canManage} />

      {/* Приглашение стоит над списком участников: до него не нужно листать (проверка интерфейса, U8). */}
      {canManage && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">{t('orgs.inviteTitle')}</h2>
          </CardHeader>
          <CardContent>
            <form action={inviteStaffAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="orgId" value={org.orgId} />
              <FormField name="email" label={t('orgs.inviteEmail')} type="email" autoComplete="off" maxLength={254} required className="min-w-64 flex-1" />
              <fieldset className="flex items-center gap-4">
                <legend className="sr-only">{t('orgs.role')}</legend>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="radio" name="role" value="client_user" defaultChecked className="size-4 accent-primary" />
                  {t('orgs.roles.client_user')}
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="radio" name="role" value="client_admin" className="size-4 accent-primary" />
                  {t('orgs.roles.client_admin')}
                </label>
              </fieldset>
              <Button type="submit">{t('orgs.invite')}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Широкая таблица прокручивается внутри карточки, а не растягивает страницу (проверка интерфейса, U9). relative:
          скрытая подпись столбца действий стоит absolute и без этого выходила за карточку, растягивая страницу на 768. */}
      <Card className="relative min-w-0 overflow-x-auto" data-testid="org-members">
        <CardHeader className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t('orgs.membersTitle')}</h2>
          <form method="get" role="search" className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor="field-member-q">{t('orgs.memberSearch')}</Label>
              <Input id="field-member-q" name="mq" type="search" maxLength={100} defaultValue={memberQuery} />
            </div>
            <Button type="submit" variant="secondary">
              {t('orgs.memberSearchSubmit')}
            </Button>
          </form>
        </CardHeader>
        {members.length === 0 && (
          <CardContent>
            <p className="text-sm text-secondary-foreground">{t(memberQuery ? 'orgs.membersEmpty' : 'orgs.membersNone')}</p>
          </CardContent>
        )}
        <table className="w-full text-sm" hidden={members.length === 0}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={head}>{t('orgs.memberName')}</th>
              <th scope="col" className={head}>{t('orgs.email')}</th>
              <th scope="col" className={head}>{t('orgs.role')}</th>
              <th scope="col" className={head}>{t('orgs.source')}</th>
              <th scope="col" className={head}>{t('orgs.memberState')}</th>
              {canManage && (
                <th scope="col" className={head}>
                  <span className="sr-only">{t('orgs.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId} className="h-row border-b border-border last:border-b-0">
                <td className={`${cell} font-medium`}>{member.name}</td>
                <td className={cell}>{member.email ?? <span className="text-secondary-foreground">{t('orgs.emailNone')}</span>}</td>
                <td className={cell}>{t(`orgs.roles.${member.role}`)}</td>
                <td className={cell}>{t(`orgs.sources.${member.source}`)}</td>
                <td className={cell}>{t(`orgs.memberStates.${member.state}`)}</td>
                {canManage && (
                  <td className={`${cell} py-1`}>
                    <div className="flex justify-end gap-2">
                      <form action={changeRoleAction}>
                        <input type="hidden" name="orgId" value={org.orgId} />
                        <input type="hidden" name="userId" value={member.userId} />
                        <input type="hidden" name="role" value={member.role === 'client_admin' ? 'client_user' : 'client_admin'} />
                        <Button type="submit" variant="secondary" size="small">
                          {t(member.role === 'client_admin' ? 'orgs.makeUser' : 'orgs.makeAdmin')}
                        </Button>
                      </form>
                      {member.state === 'active' ? (
                        <form method="get">
                          <input type="hidden" name="confirm" value={member.userId} />
                          <Button type="submit" variant="secondary" size="small">
                            {t('orgs.disable')}
                          </Button>
                        </form>
                      ) : (
                        <form action={setMemberStateStaffAction}>
                          <input type="hidden" name="orgId" value={org.orgId} />
                          <input type="hidden" name="userId" value={member.userId} />
                          <input type="hidden" name="state" value="active" />
                          <Button type="submit" variant="secondary" size="small">
                            {t('orgs.enable')}
                          </Button>
                        </form>
                      )}
                      {isAdmin && (
                        <form method="get">
                          <input type="hidden" name="anonymize" value={member.userId} />
                          <Button type="submit" variant="ghost" size="small">
                            {t('orgs.anonymize.button')}
                          </Button>
                        </form>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {(membersNext || memberAfter) && (
          <CardContent className="flex flex-wrap gap-4 pt-3">
            {memberAfter && (
              <Link href={`/agent/organizations/${org.orgId}${memberQuery ? `?mq=${encodeURIComponent(memberQuery)}` : ''}`} className="text-sm font-medium text-link underline-offset-2 hover:underline">
                {t('orgs.membersFirst')}
              </Link>
            )}
            {membersNext && (
              <Link
                href={`/agent/organizations/${org.orgId}?${new URLSearchParams({ ...(memberQuery ? { mq: memberQuery } : {}), after: membersNext }).toString()}`}
                className="text-sm font-medium text-link underline-offset-2 hover:underline"
                data-testid="members-next"
              >
                {t('orgs.membersNext')}
              </Link>
            )}
          </CardContent>
        )}
      </Card>

      {canManage && (
        <>
          <Card className="relative min-w-0 overflow-x-auto">
            <CardHeader>
              <h2 className="text-base font-semibold">{t('orgs.invitationsTitle')}</h2>
            </CardHeader>
            {invitations.length === 0 ? (
              <CardContent>
                <p className="text-sm text-secondary-foreground">{t('orgs.invitationsEmpty')}</p>
              </CardContent>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={head}>{t('orgs.email')}</th>
                    <th scope="col" className={head}>{t('orgs.role')}</th>
                    <th scope="col" className={head}>{t('orgs.expires')}</th>
                    <th scope="col" className={head}>{t('orgs.memberState')}</th>
                    <th scope="col" className={head}>
                      <span className="sr-only">{t('orgs.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.invitationId} className="h-row border-b border-border last:border-b-0">
                      <td className={cell}>{invitation.email}</td>
                      <td className={cell}>{t(`orgs.roles.${invitation.role}`)}</td>
                      <td className={cell}>{format.dateTime(invitation.expiresOn, { dateStyle: 'medium' })}</td>
                      <td className={cell}>{t(`orgs.invitationStates.${invitation.status}`)}</td>
                      <td className={`${cell} py-1 text-end`}>
                        {invitation.status === 'pending' && (
                          <form action={revokeStaffAction}>
                            <input type="hidden" name="orgId" value={org.orgId} />
                            <input type="hidden" name="invitationId" value={invitation.invitationId} />
                            <Button type="submit" variant="secondary" size="small">
                              {t('orgs.revoke')}
                            </Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  );
}
