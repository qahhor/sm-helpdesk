import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { orgTicketSummary } from '@/modules/hdt/api';
import { listInvitations, listMembers, requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { cn } from '@/ui/cn';
import { revokeInvitationAction, setMemberStateAction } from './actions';
import { InviteForm } from './InviteForm';
import { firstParam } from '@/lib/search-params';

const ERRORS = new Set(['already_member', 'invalid_input', 'rate_limited', 'forbidden', 'not_found']);
const DONE = new Set(['invited', 'revoked', 'disabled', 'enabled']);

/** Ячейка таблицы. На телефоне строка таблицы становится карточкой, подпись столбца видна рядом со значением. */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <td role="cell" className={cn('tablet:px-3 tablet:py-2', className)}>
      <span className="text-sm text-secondary-foreground tablet:sr-only">{label}: </span>
      {children}
    </td>
  );
}

const rowClass = 'flex flex-col gap-1 border-b border-border py-3 last:border-b-0 tablet:table-row tablet:py-0';
const headClass = 'px-3 py-2 text-start text-sm font-medium text-secondary-foreground';

// Организация клиента (FR-ID-08, FR-ID-13): участники, приглашения, приглашение коллеги.
// Только администратору клиента: остальным страницы нет (404). Данные строго своей организации из актора.
export default async function OrgPage({ searchParams }: PageProps<'/[locale]/org'>) {
  const client = await requireClientActor();
  if (client.actor.orgRole !== 'client_admin') notFound();
  const params = await searchParams;
  const [members, invitations, summary] = await Promise.all([listMembers({ ctx: client }), listInvitations({ ctx: client }), orgTicketSummary(client)]);
  const t = await getTranslations('client.org');
  const ts = await getTranslations('client.tickets.statuses');
  const format = await getFormatter();
  const error = firstParam(params.error);
  const done = firstParam(params.done);
  const confirmId = firstParam(params.confirm);
  const confirming = members.find((m) => m.userId === confirmId && m.state === 'active' && !m.isSelf);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-secondary-foreground">{client.org.name}</p>
      </div>

      {error && ERRORS.has(error) && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
      {done && DONE.has(done) && <Alert tone="success">{t(`done.${done}`)}</Alert>}

      {/* Сводка по обращениям организации (ТЗ 5.1; волна 7, T8): числа по статусам, только своя организация. */}
      <Card data-testid="org-summary">
        <CardHeader>
          <h2 className="text-lg font-semibold">{t('summary.title')}</h2>
          <p className="text-secondary-foreground">{t('summary.total', { total: summary.total, open: summary.open })}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-3 tablet:grid-cols-3">
            {(Object.keys(summary.byStatus) as (keyof typeof summary.byStatus)[]).map((status) => (
              <div key={status} className="flex flex-col gap-1 rounded-card border border-border p-3" data-status={status}>
                <dt className="text-sm text-secondary-foreground">{ts(status)}</dt>
                <dd className="text-xl font-semibold tabular-nums">{format.number(summary.byStatus[status])}</dd>
              </div>
            ))}
          </dl>
          <Link href="/tickets?scope=org" className="self-start text-link underline underline-offset-2">
            {t('summary.open')}
          </Link>
        </CardContent>
      </Card>

      {confirming && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <h2 className="text-lg font-semibold">{t('members.confirmTitle', { name: confirming.name })}</h2>
            <p className="text-secondary-foreground">{t('members.confirmText')}</p>
            <div className="flex flex-col gap-3 tablet:flex-row">
              <form action={setMemberStateAction}>
                <input type="hidden" name="userId" value={confirming.userId} />
                <input type="hidden" name="state" value="passive" />
                <Button type="submit" variant="danger" className="w-full">
                  {t('members.confirm')}
                </Button>
              </form>
              <a href="?" className={buttonVariants({ variant: 'secondary' })}>
                {t('members.cancel')}
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">{t('invite.title')}</h2>
        </CardHeader>
        <CardContent>
          <InviteForm
            labels={{
              email: t('invite.email'),
              role: t('invite.role'),
              user: t('roles.client_user'),
              admin: t('roles.client_admin'),
              submit: t('invite.submit'),
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">{t('members.title')}</h2>
        </CardHeader>
        <CardContent>
          <table role="table" className="block w-full tablet:table">
            <thead className="max-tablet:sr-only">
              <tr role="row">
                <th role="columnheader" scope="col" className={headClass}>{t('members.name')}</th>
                <th role="columnheader" scope="col" className={headClass}>{t('members.role')}</th>
                <th role="columnheader" scope="col" className={headClass}>{t('members.state')}</th>
                <th role="columnheader" scope="col" className={headClass}>
                  <span className="sr-only">{t('members.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="block tablet:table-row-group">
              {members.map((member) => (
                <tr role="row" key={member.userId} className={rowClass}>
                  <Cell label={t('members.name')} className="font-medium">
                    {member.name}
                    {member.isSelf && <span className="ms-2 text-sm font-normal text-secondary-foreground">{t('members.self')}</span>}
                  </Cell>
                  <Cell label={t('members.role')}>{t(`roles.${member.role}`)}</Cell>
                  <Cell label={t('members.state')}>{t(`members.${member.state}`)}</Cell>
                  <td role="cell" className="pt-1 tablet:px-3 tablet:py-2 tablet:text-end">
                    {!member.isSelf && member.state === 'active' && (
                      // Отключение просит подтверждения: кнопка открывает его на этой же странице.
                      <form method="get">
                        <input type="hidden" name="confirm" value={member.userId} />
                        <Button type="submit" variant="secondary">
                          {t('members.disable')}
                        </Button>
                      </form>
                    )}
                    {!member.isSelf && member.state === 'passive' && (
                      <form action={setMemberStateAction}>
                        <input type="hidden" name="userId" value={member.userId} />
                        <input type="hidden" name="state" value="active" />
                        <Button type="submit" variant="secondary">
                          {t('members.enable')}
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">{t('invitations.title')}</h2>
        </CardHeader>
        <CardContent>
          {invitations.length === 0 ? (
            <p className="text-secondary-foreground">{t('invitations.empty')}</p>
          ) : (
            <table role="table" className="block w-full tablet:table">
              <thead className="max-tablet:sr-only">
                <tr role="row">
                  <th role="columnheader" scope="col" className={headClass}>{t('invitations.email')}</th>
                  <th role="columnheader" scope="col" className={headClass}>{t('invitations.role')}</th>
                  <th role="columnheader" scope="col" className={headClass}>{t('invitations.expires')}</th>
                  <th role="columnheader" scope="col" className={headClass}>{t('invitations.status')}</th>
                  <th role="columnheader" scope="col" className={headClass}>
                    <span className="sr-only">{t('members.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="block tablet:table-row-group">
                {invitations.map((invitation) => (
                  <tr role="row" key={invitation.invitationId} className={rowClass}>
                    <Cell label={t('invitations.email')} className="font-medium wrap-anywhere">
                      {invitation.email}
                    </Cell>
                    <Cell label={t('invitations.role')}>{t(`roles.${invitation.role}`)}</Cell>
                    <Cell label={t('invitations.expires')}>{format.dateTime(invitation.expiresOn, { dateStyle: 'medium' })}</Cell>
                    <Cell label={t('invitations.status')}>{t(`invitations.${invitation.status}`)}</Cell>
                    <td role="cell" className="pt-1 tablet:px-3 tablet:py-2 tablet:text-end">
                      {invitation.status === 'pending' && (
                        <form action={revokeInvitationAction}>
                          <input type="hidden" name="invitationId" value={invitation.invitationId} />
                          <Button type="submit" variant="secondary">
                            {t('invitations.revoke')}
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
