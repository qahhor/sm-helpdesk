import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { renderTemplate } from '@/modules/hdr/api';
import { ALLOWED_FILE_EXTENSIONS, DEVELOPMENT_ROLES, allowedStaffTransitions, MAX_FILES_PER_MESSAGE, TRANSFER_REASONS } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { SlaBadge, slaLabelKey } from '@/ui/agent/SlaBadge';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { acceptOf, STATUS_TONE } from '@/ui/ticket-status';
import { inviteSenderAction } from './actions';
import { Composer } from './Composer';
import { DevTaskBlock } from './DevTaskBlock';
import { MacroMenu } from './MacroMenu';
import { MergeDialog } from './MergeDialog';
import { PresenceBar } from './PresenceBar';
import { SeenMark } from './SeenMark';
import { ReturnDialog } from './ReturnDialog';
import { TicketControls } from './TicketControls';
import { SolutionBlock } from './SolutionBlock';
import { RelatedSolutions } from './RelatedSolutions';
import { loadTicketPage, type TicketPageSearch } from './loader';
import { TicketKeys } from './TicketKeys';
import { TicketTags } from './TicketTags';
import { TicketTimeline } from './Timeline';
import { TransferDialog } from './TransferDialog';

// Обращение у сотрудника (раздел 8.4 "Обращение у агента", FR-AG-04, FR-AG-05, UX-A-14, UX-A-15).
// Слева переписка с заметками и историей, справа клиент, сроки, контекст. Новое с прошлого визита отмечено.

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}


export default async function AgentTicketPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<TicketPageSearch> }) {
  const staff = await requireStaffActor();
  const search = await searchParams;
  const t = await getTranslations('agent');
  const tc = await getTranslations('client.tickets');
  const data = await loadTicketPage(staff, safeDecode((await params).number), search, await getLocale());
  if (!data) notFound();
  const { ticket, canWrite, assignable, modules, draft, templates, knownTags, macros, canTransfer, canReturn, playbook, devTask, canDevelop, canHandOver, devMode, fromQueue, fromSort, done, error, changed } = data;
  const playbookScope = playbook
    ? `${playbook.moduleId ? (modules.find((m) => m.moduleId === playbook.moduleId)?.name ?? '') : t('ticket.transfer.anyModule')} / ${t(`ticket.types.${ticket.type}`)}`
    : null;
  const format = await getFormatter();
  const when = (date: Date) => format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
  const label = `SUP-${ticket.number}`;
  const statusName = (status: unknown) => (typeof status === 'string' && t.has(`queues.statuses.${status}`) ? t(`queues.statuses.${status}`) : String(status ?? ''));

  const slaLine = (due: Date | null) => (due ? when(due) : t('ticket.noDeadline'));
  const left = slaLabelKey(ticket.sla.minutesLeft);

  return (
    <>
      <PageHeader
        title={`${label}  ${ticket.title}`}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('queues.title'), href: '/agent/queues' }, { label }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusLabel tone={STATUS_TONE[ticket.status] ?? 'gray'}>{statusName(ticket.status)}</StatusLabel>
            <span>{t(`ticket.types.${ticket.type}`)}</span>
            <span className="font-semibold">{ticket.priority.toUpperCase()}</span>
            {!ticket.priorityConfirmed && <span className="text-muted-foreground">{t('ticket.priorityUnconfirmed')}</span>}
            <span className="text-muted-foreground">{t(`ticket.lines.${ticket.line}`)}</span>
            {ticket.snoozedUntil && <span className="text-muted-foreground">{t('ticket.snoozed', { time: when(ticket.snoozedUntil) })}</span>}
            {ticket.snoozeReturned && <StatusLabel tone="orange">{t('ticket.snoozeReturned')}</StatusLabel>}
            {ticket.senderUnconfirmed && <StatusLabel tone="orange">{t('ticket.senderUnconfirmed')}</StatusLabel>}
          </div>
          {ticket.guestSender && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {ticket.senderUnconfirmed && <span className="text-secondary-foreground">{t('ticket.senderUnconfirmedHint')}</span>}
              {canWrite && (
                <form action={inviteSenderAction}>
                  <input type="hidden" name="number" value={ticket.number} />
                  <Button type="submit" variant="secondary" size="small">
                    {t('ticket.inviteSender')}
                  </Button>
                </form>
              )}
            </div>
          )}
          {done && <Alert tone="success">{t(`ticket.controls.done.${done}`)}</Alert>}
          {error && (
            <Alert tone="danger">
              {t.has(`ticket.controls.errors.${error}`)
                ? t(`ticket.controls.errors.${error}`, { holder: ticket.assignee?.name ?? t('ticket.controls.someone') })
                : t('ticket.controls.errors.other')}
              {error === 'changed' && changed && (
                <ul className="list-disc ps-5">
                  {changed.newMessages > 0 && <li>{t('ticket.composer.changed.messages', { count: changed.newMessages })}</li>}
                  {changed.statusChanged && <li>{t('ticket.composer.changed.status')}</li>}
                  {changed.assigneeChanged && <li>{t('ticket.composer.changed.assignee')}</li>}
                </ul>
              )}
            </Alert>
          )}
          {ticket.changedSince && <p className="text-sm text-muted-foreground">{t('ticket.lastVisit', { time: when(ticket.changedSince) })}</p>}
          <TicketKeys
            number={ticket.number}
            me={staff.user.id}
            canWrite={canWrite}
            canTake={ticket.assignee?.id !== staff.user.id && (ticket.line === 'l1' || (DEVELOPMENT_ROLES as readonly string[]).includes(staff.actor.staffRole))}
            transitions={allowedStaffTransitions(ticket.status, staff.actor.staffRole, { merged: ticket.mergedInto !== null }).map((to) => ({
              to,
              label: statusName(to),
            }))}
            templates={templates.map((template) => ({ shortcut: template.shortcut, title: template.title, ...renderTemplate(template, ticket.locale) }))}
            labels={{
              group: t('keys.commands.group'),
              templates: t('keys.commands.templates'),
              take: t('keys.commands.take'),
              assignMe: t('keys.commands.assignMe'),
              status: t.raw('keys.commands.status') as string,
              template: t.raw('keys.commands.template') as string,
            }}
          />
          <SeenMark ticketId={ticket.ticketId} />
          <PresenceBar number={ticket.number} labels={{ viewing: t.raw('ticket.presence.viewing') as string, typing: t.raw('ticket.presence.typing') as string }} />
          <TicketTimeline ticket={ticket} from={{ queue: search.queue, sort: search.sort }} />
          {canWrite && macros.length > 0 && (
            <MacroMenu number={ticket.number} version={ticket.version} macros={macros} labels={{ open: t('ticket.macros.open'), list: t('ticket.macros.list'), busy: t('ticket.macros.busy') }} />
          )}
          {canWrite && (
            <Composer
              key={ticket.version}
              number={ticket.number}
              version={ticket.version}
              draft={draft ? { body: draft.body, internal: draft.internal } : null}
              accept={acceptOf(ALLOWED_FILE_EXTENSIONS)}
              maxFiles={MAX_FILES_PER_MESSAGE}
              // Шаблон на языке обращения, без перевода русский с отметкой для агента (FR-AG-06).
              queue={fromQueue}
              sort={fromSort}
              templates={templates.map((template) => ({ shortcut: template.shortcut, title: template.title, ...renderTemplate(template, ticket.locale), isEnabled: true as const }))}
              labels={{
                templates: {
                  open: t('ticket.composer.templates.open'),
                  list: t('ticket.composer.templates.list'),
                  empty: t('ticket.composer.templates.empty'),
                  fallback: t('ticket.composer.templates.fallback'),
                },
                form: t('ticket.composer.form'),
                mode: t('ticket.composer.mode'),
                modeReply: t('ticket.composer.modeReply'),
                modeNote: t('ticket.composer.modeNote'),
                replyField: t('ticket.composer.replyField'),
                noteField: t('ticket.composer.noteField'),
                noteHint: t('ticket.composer.noteHint'),
                waitForClient: t('ticket.composer.waitForClient'),
                send: t('ticket.composer.send'),
                saveNote: t('ticket.composer.saveNote'),
                sendNext: t('ticket.composer.sendNext'),
                busy: tc('files.busy'),
                draftSaved: t('ticket.composer.draftSaved'),
                errors: Object.fromEntries(
                  ['invalid_input', 'forbidden', 'not_found', 'transition_refused', 'file_unavailable', 'merged', 'other'].map((code) => [code, t(`ticket.composer.errors.${code}`)]),
                ),
                changed: {
                  title: t('ticket.composer.changed.title'),
                  messages: t.raw('ticket.composer.changed.messages') as string,
                  status: t('ticket.composer.changed.status'),
                  assignee: t('ticket.composer.changed.assignee'),
                  show: t('ticket.composer.changed.show'),
                  sendAnyway: t('ticket.composer.changed.sendAnyway'),
                },
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
        </div>
        <aside className="flex flex-col gap-4" aria-label={t('ticket.details')}>
          <TicketControls ticket={ticket} me={staff.user.id} role={staff.actor.staffRole} staff={assignable} modules={modules} />
          <TicketTags number={ticket.number} tags={ticket.tags} known={knownTags} canWrite={canWrite} />
          <DevTaskBlock number={ticket.number} devTask={devTask} canManage={canDevelop} canHandOver={canHandOver} mode={devMode} />
          <SolutionBlock staff={staff} ticketId={ticket.ticketId} number={ticket.number} status={ticket.status} />
          <RelatedSolutions staff={staff} ticketId={ticket.ticketId} locale={ticket.locale} canWrite={canWrite} />
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6 text-sm">
              <h2 className="text-xs font-medium text-secondary-foreground">{t('ticket.clientTitle')}</h2>
              <p className="font-semibold">{ticket.org?.name ?? ''}</p>
              {ticket.org?.inn && <p>{t('ticket.inn', { inn: ticket.org.inn })}</p>}
              {ticket.org && <p>{t('ticket.server', { server: ticket.org.serverName })}</p>}
              {ticket.org?.category && <p>{t('ticket.category', { category: ticket.org.category })}</p>}
              <p className="mt-2">{ticket.author.name ?? ''}</p>
              {ticket.author.email && <p className="break-all text-muted-foreground">{ticket.author.email}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6 text-sm">
              <h2 className="text-xs font-medium text-secondary-foreground">{t('ticket.slaTitle')}</h2>
              <p>{t('ticket.firstResponse', { time: ticket.sla.firstRespondedOn ? t('ticket.done', { time: when(ticket.sla.firstRespondedOn) }) : slaLine(ticket.sla.firstResponseDueOn) })}</p>
              <p>{t('ticket.resolution', { time: ticket.sla.pausedSince ? t('ticket.paused') : slaLine(ticket.sla.resolutionDueOn) })}</p>
              {ticket.status !== 'resolved' && ticket.status !== 'closed' && !ticket.sla.pausedSince && (
                <SlaBadge phase={ticket.sla.phase} label={t(`queues.sla.${left.key}`, { value: left.value })} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6 text-sm">
              <h2 className="text-xs font-medium text-secondary-foreground">{t('ticket.workTitle')}</h2>
              <p>{t('ticket.line', { line: t(`ticket.lines.${ticket.line}`) })}</p>
              {ticket.mergedInto && (
                <p data-merged>
                  <Link href={`/agent/tickets/SUP-${ticket.mergedInto.number}`} className="text-link underline-offset-2 hover:underline">
                    {t('ticket.mergedInto', { number: `SUP-${ticket.mergedInto.number}` })}
                  </Link>
                </p>
              )}
              {ticket.pickup && <p data-pickup>{t('ticket.pickupDue', { time: when(ticket.pickup.dueOn) })}</p>}
              <p>{t('ticket.assignee', { name: ticket.assignee?.name ?? t('queues.unassigned') })}</p>
              <p>{t('ticket.source', { source: t(`ticket.sources.${ticket.source}`) })}</p>
              {canTransfer && (
                <TransferDialog
                  number={ticket.number}
                  reasons={TRANSFER_REASONS.map((value) => ({ value, label: t(`ticket.transfer.reasons.${value}`) }))}
                  items={playbook?.items ?? []}
                  labels={{
                    open: t('ticket.transfer.open'),
                    title: t('ticket.transfer.title'),
                    reason: t('ticket.transfer.reason'),
                    reasonHint: t('ticket.transfer.reasonHint'),
                    playbook: playbookScope ? t('ticket.transfer.playbook', { scope: playbookScope }) : null,
                    noPlaybook: t('ticket.transfer.noPlaybook'),
                    playbooksLink: t('ticket.transfer.playbooksLink'),
                    checked: t('ticket.transfer.checked'),
                    needed: t('ticket.transfer.needed'),
                    deadline: !ticket.sla.firstRespondedOn && ticket.sla.firstResponseDueOn
                      ? t('ticket.transfer.deadlineReply', { time: when(ticket.sla.firstResponseDueOn) })
                      : ticket.sla.resolutionDueOn
                        ? t('ticket.transfer.deadlineResolution', { time: when(ticket.sla.resolutionDueOn) })
                        : t('ticket.transfer.deadlineNone'),
                    cancel: t('ticket.transfer.cancel'),
                    submit: t('ticket.transfer.submit'),
                    close: t('ticket.transfer.close'),
                  }}
                />
              )}
              {canWrite && ticket.status !== 'closed' && (
                <MergeDialog
                  number={ticket.number}
                  labels={{
                    open: t('ticket.merge.open'),
                    title: t('ticket.merge.title'),
                    text: t('ticket.merge.text'),
                    into: t('ticket.merge.into'),
                    cancel: t('ticket.transfer.cancel'),
                    submit: t('ticket.merge.submit'),
                    close: t('ticket.transfer.close'),
                  }}
                />
              )}
              {canReturn && (
                <ReturnDialog
                  number={ticket.number}
                  labels={{
                    open: t('ticket.return.open'),
                    title: t('ticket.return.title'),
                    explanation: t('ticket.return.explanation'),
                    cancel: t('ticket.transfer.cancel'),
                    submit: t('ticket.return.submit'),
                    close: t('ticket.transfer.close'),
                  }}
                />
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
