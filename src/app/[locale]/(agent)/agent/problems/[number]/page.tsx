import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LOCALES } from '@/i18n/locales';
import { firstParam } from '@/lib/search-params';
import { HDP_ERROR_CODES, PROBLEM_WRITER_ROLES, parseProblemRef, problemRef, SETTABLE_PROBLEM_STATUSES } from '@/modules/hdp/api';
import { problemCard } from '@/modules/hdp/api/problems';
import { listBroadcasts } from '@/modules/hdp/api/broadcasts';
import { namesOf } from '@/modules/hdu/api';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { DevTaskBlock } from '../../tickets/[number]/DevTaskBlock';
import { DEV_TASK_ERROR_CODES, devTrackerMode, readDevTaskForProblem } from '@/modules/hdw/api/dev-tasks';
import { DEVELOPMENT_ROLES } from '@/modules/hdt/api';
import { addSignatureAction, problemDevTaskLinkAction, problemDevTaskStatusAction, problemDevTaskUnlinkAction, prepareBroadcastAction, problemShownAction, problemStatusAction, problemTranslationAction, removeSignatureAction, requestTranslationAction, saveProblemAction } from '../actions';
import { PROBLEM_STATUS_TONE } from '../status-tone';
import { AgentDraftBlock } from './AgentDraftBlock';

// Карточка известной проблемы (ТЗ 8.12 "Известная проблема", образец "Карточка"; FR-KP-01, 02, 10, FR-ADM-12; план M5c,
// задача 2). Слева вкладки "Описание", "Обращения", "Обновления", справа сведения FR-KP-10 и сигнатуры. Внутреннее
// название и обращения видят только сотрудники. Публичный текст пишет сотрудник; машинный перевод клиенту не виден,
// пока его не приняли. Менять могут agent_l2, care, admin; остальные сотрудники читают.

const TABS = ['description', 'tickets', 'updates'] as const;
type Tab = (typeof TABS)[number];
const DONE = ['draft_accepted', 'proposals_linked', 'draft_rejected', 'created', 'saved', 'status', 'shown', 'hidden', 'translation', 'translating', 'signature_added', 'signature_removed', 'broadcast_sent', 'dev_linked', 'dev_unlinked', 'dev_status'];
const FINDING_KINDS = ['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal', 'link', 'org'];
const label = 'text-xs font-medium text-secondary-foreground';

export default async function AgentProblemPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ status?: string; tab?: string; kinds?: string }> }) {
  const staff = await requireStaffActor();
  const number = parseProblemRef((await params).number);
  if (!number) notFound();
  const card = await problemCard(staff, number);
  if (!card) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.problems');
  const ts = await getTranslations('agent.queues');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const status = firstParam(search.status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const devCode = status.startsWith('dev-error-') ? status.slice(10) : null;
  const kinds = (firstParam(search.kinds) ?? '')
    .split(',')
    .filter((k) => FINDING_KINDS.includes(k))
    .map((k) => s(`findings.${k}`))
    .join(', ');
  const tab: Tab = (TABS as readonly string[]).includes(firstParam(search.tab) ?? '') ? (firstParam(search.tab) as Tab) : 'description';
  const modules = await listActiveModules(staff.actor, locale);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const canWrite = (PROBLEM_WRITER_ROLES as readonly string[]).includes(staff.actor.staffRole) && card.status !== 'closed';
  const when = (value: Date | null) => (value ? format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' }) : s('info.never'));
  const hidden = <input type="hidden" name="number" value={card.number} />;
  const updates = await listBroadcasts(staff, card.number);
  const devTask = await readDevTaskForProblem(staff, card.number);
  const canDevelop = (DEVELOPMENT_ROLES as readonly string[]).includes(staff.actor.staffRole);
  const authors = await namesOf(staff.actor, [...new Set(updates.map((u) => u.authorId))]);
  const categories = Object.entries(card.categories)
    .map(([key, count]) => `${key === 'none' ? s('info.categoryNone') : key} ${count}`)
    .join(', ');

  return (
    <>
      <PageHeader
        title={`${problemRef(card.number)}  ${card.internalTitle}`}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/problems' }, { label: problemRef(card.number) }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="grid gap-4 lg:grid-cols-3" data-testid="agent-problem">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {devCode && <Alert tone="danger">{s(`devTask.errors.${(DEV_TASK_ERROR_CODES as readonly string[]).includes(devCode) ? devCode : 'other'}`)}</Alert>}
          {code && <Alert tone="danger">{s(`errors.${(HDP_ERROR_CODES as readonly string[]).includes(code) ? code : 'forbidden'}`, { kinds })}</Alert>}
          {DONE.includes(status) && <Alert tone="success">{s(`done.${status}`)}</Alert>}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusLabel tone={PROBLEM_STATUS_TONE[card.status]}>{s(`statuses.${card.status}`)}</StatusLabel>
            {card.moduleId && <span>{moduleName.get(card.moduleId) ?? ''}</span>}
            <StatusLabel tone={card.showToClients ? 'teal' : 'gray'}>{card.showToClients ? s('shown') : s('hidden')}</StatusLabel>
          </div>
          <AgentDraftBlock
            number={card.number}
            isDraft={card.status === 'draft'}
            canWrite={canWrite}
            description={card.internalDescription}
            proposals={card.proposals}
            labels={{
              title: s('draft.title'),
              mark: t('aiStaff.mark'),
              hint: s('draft.hint'),
              description: s('draft.description'),
              proposals: s('draft.proposals'),
              noProposals: s('draft.noProposals'),
              accept: s('draft.accept'),
              linkProposed: s('draft.linkProposed'),
              linkHint: s('draft.linkHint'),
              reject: s('draft.reject'),
              reason: s('draft.reason'),
            }}
          />
          <nav aria-label={s('tabs.label')} className="flex flex-wrap gap-2">
            {TABS.map((value) => (
              <Link
                key={value}
                href={`/agent/problems/${card.number}?tab=${value}`}
                aria-current={value === tab ? 'page' : undefined}
                className={`inline-flex min-h-control items-center rounded-chip border px-4 text-sm font-medium ${value === tab ? 'border-primary bg-selected text-selected-foreground' : 'border-border bg-card text-foreground hover:bg-card-soft'}`}
              >
                {s(`tabs.${value}`, { count: value === 'tickets' ? card.ticketCount : updates.length })}
              </Link>
            ))}
          </nav>

          {tab === 'description' && (
            <>
              <Card>
                <CardContent className="flex flex-col gap-3 pt-6">
                  {canWrite ? (
                    <form action={saveProblemAction} className="flex flex-col gap-2">
                      {hidden}
                      <Label htmlFor="problem-title">{s('internalTitle')}</Label>
                      <Input id="problem-title" name="internalTitle" required maxLength={200} defaultValue={card.internalTitle} aria-describedby="problem-title-hint" />
                      <p id="problem-title-hint" className="text-xs text-muted-foreground">
                        {s('internalTitleHint')}
                      </p>
                      <Label htmlFor="problem-module">{s('fields.module')}</Label>
                      <Select id="problem-module" name="moduleId" defaultValue={card.moduleId ?? ''}>
                        <option value="">{s('fields.noModule')}</option>
                        {modules.map((m) => (
                          <option key={m.moduleId} value={m.moduleId}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                      <Label htmlFor="problem-workaround">{s('fields.workaround')}</Label>
                      <Input id="problem-workaround" name="workaroundNumber" inputMode="numeric" pattern="[0-9]*" maxLength={9} defaultValue={card.workaround ? String(card.workaround.number) : ''} aria-describedby="problem-workaround-hint" />
                      <p id="problem-workaround-hint" className="text-xs text-muted-foreground">
                        {s('fields.workaroundHint')}
                      </p>
                      <Button type="submit" className="self-start">
                        {s('save')}
                      </Button>
                    </form>
                  ) : (
                    card.workaround && (
                      <p>
                        {s('fields.workaround')}: {card.workaround.number}
                      </p>
                    )
                  )}
                  {canWrite && card.status !== 'draft' && (
                    <div className="flex flex-wrap items-end gap-3">
                      <form action={problemStatusAction} className="flex flex-wrap items-end gap-2">
                        {hidden}
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="problem-status">{s('fields.status')}</Label>
                          <Select id="problem-status" name="status" defaultValue={card.status}>
                            {SETTABLE_PROBLEM_STATUSES.map((value) => (
                              <option key={value} value={value}>
                                {s(`statuses.${value}`)}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button type="submit" variant="secondary">
                          {s('changeStatus')}
                        </Button>
                      </form>
                      <form action={problemShownAction} className="flex flex-col gap-1">
                        {hidden}
                        <input type="hidden" name="shown" value={card.showToClients ? 'false' : 'true'} />
                        <Button type="submit" variant="secondary" aria-describedby="problem-show-hint">
                          {card.showToClients ? s('hide') : s('show')}
                        </Button>
                        <p id="problem-show-hint" className="text-xs text-muted-foreground">
                          {s('fields.showHint')}
                        </p>
                      </form>
                    </div>
                  )}
                </CardContent>
              </Card>
              {LOCALES.map((lang) => {
                const text = card.translations.find((x) => x.locale === lang);
                return (
                  <Card key={lang} data-locale={lang}>
                    <CardHeader>
                      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                        {s('public.title', { locale: lang.toUpperCase() })}
                        {lang === card.sourceLocale && <StatusLabel tone="gray">{s('public.original')}</StatusLabel>}
                        {text?.isMachine && <StatusLabel tone={text.accepted ? 'green' : 'blue'}>{text.accepted ? s('public.accepted') : s('public.machine')}</StatusLabel>}
                      </h2>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2" lang={lang}>
                      {text?.isMachine && !text.accepted && <p className="text-sm text-secondary-foreground">{s('public.notAccepted')}</p>}
                      {canWrite ? (
                        <form action={problemTranslationAction} className="flex flex-col gap-2">
                          {hidden}
                          <input type="hidden" name="locale" value={lang} />
                          <p className="text-xs text-muted-foreground">{s('public.hint')}</p>
                          <Label htmlFor={`public-title-${lang}`}>{s('public.publicTitle')}</Label>
                          <Input id={`public-title-${lang}`} name="publicTitle" maxLength={200} defaultValue={text?.publicTitle ?? ''} />
                          <Label htmlFor={`public-body-${lang}`}>{s('public.publicBody')}</Label>
                          <Textarea id={`public-body-${lang}`} name="publicBody" rows={4} maxLength={5000} defaultValue={text?.publicBody ?? ''} />
                          <div className="flex flex-wrap gap-2">
                            <Button type="submit" variant="secondary" size="small">
                              {s('public.save')}
                            </Button>
                            {text?.isMachine && !text.accepted && (
                              <Button type="submit" size="small" name="accept" value="true">
                                {s('public.accept')}
                              </Button>
                            )}
                          </div>
                        </form>
                      ) : text ? (
                        <>
                          <p className="break-words font-semibold">{text.publicTitle}</p>
                          <p className="whitespace-pre-wrap break-words">{text.publicBody}</p>
                        </>
                      ) : (
                        <p className="text-sm text-secondary-foreground">{s('public.empty')}</p>
                      )}
                      {canWrite && lang !== card.sourceLocale && (
                        <form action={requestTranslationAction}>
                          {hidden}
                          <input type="hidden" name="locale" value={lang} />
                          <Button type="submit" variant="ghost" size="small">
                            {s('public.translate')}
                          </Button>
                        </form>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </>
          )}

          {tab === 'tickets' && (
            <Card className="overflow-x-auto">
              {card.tickets.length === 0 ? (
                <CardContent className="pt-6 text-sm text-secondary-foreground">{s('tickets.none')}</CardContent>
              ) : (
                <table className="w-full text-sm" aria-label={s('tabs.tickets', { count: card.ticketCount })} data-testid="problem-tickets">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      {(['number', 'title', 'status', 'org', 'created'] as const).map((column) => (
                        <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                          {s(`tickets.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {card.tickets.map((row) => (
                      <tr key={row.number} className="border-b border-border align-top last:border-b-0">
                        <td className="whitespace-nowrap px-3 py-3">
                          <Link href={`/agent/tickets/SUP-${row.number}`} className="text-link underline underline-offset-2">
                            SUP-{row.number}
                          </Link>
                        </td>
                        <td className="break-words px-3 py-3">{row.title}</td>
                        <td className="px-3 py-3">{ts(`statuses.${row.status}`)}</td>
                        <td className="px-3 py-3">{row.orgName}</td>
                        <td className="whitespace-nowrap px-3 py-3">{when(row.createdOn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          )}

          {tab === 'updates' && (
            <>
              {canWrite && (
                <div className="grid gap-4 laptop:grid-cols-2">
                  {(['update', 'closing'] as const).map((kind) => (
                    <Card key={kind}>
                      <CardHeader>
                        <h2 className="text-lg font-semibold">{kind === 'closing' ? s('broadcast.closeTitle') : s('broadcast.title')}</h2>
                      </CardHeader>
                      <CardContent>
                        <form action={prepareBroadcastAction} className="flex flex-col gap-2" data-broadcast-form={kind}>
                          {hidden}
                          <input type="hidden" name="kind" value={kind} />
                          <input type="hidden" name="locale" value={locale} />
                          <Label htmlFor={`broadcast-body-${kind}`}>{kind === 'closing' ? s('broadcast.closeBody') : s('broadcast.body')}</Label>
                          <Textarea id={`broadcast-body-${kind}`} name="body" required rows={4} maxLength={5000} aria-describedby={`broadcast-body-${kind}-hint`} />
                          <p id={`broadcast-body-${kind}-hint`} className="text-xs text-muted-foreground">
                            {s('public.hint')}
                          </p>
                          <Button type="submit" variant={kind === 'closing' ? 'secondary' : 'primary'} className="self-start">
                            {kind === 'closing' ? s('broadcast.prepareClose') : s('broadcast.prepare')}
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
              <Card>
                {updates.length === 0 ? (
                  <CardContent className="pt-6 text-sm text-secondary-foreground">{s('updates.none')}</CardContent>
                ) : (
                  <CardContent className="pt-6">
                    <ul className="flex flex-col gap-3" data-testid="problem-updates">
                      {updates.map((u) => (
                        <li key={u.broadcastId} className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm">
                            <StatusLabel tone={u.status === 'done' ? 'green' : 'blue'}>{s(`broadcast.statuses.${u.status}`)}</StatusLabel>
                            <span>{u.kind === 'closing' ? s('broadcast.closeTitle') : s('broadcast.title')}</span>
                            <span className="text-secondary-foreground">{when(u.confirmedOn ?? u.createdOn)}</span>
                            <span className="text-secondary-foreground">{authors.get(u.authorId) ?? ''}</span>
                          </p>
                          <p className="text-sm tabular-nums">{s('broadcast.delivered', { delivered: u.deliveredCount, tickets: u.recipientsCount, orgs: u.orgCount })}</p>
                          <p className="whitespace-pre-wrap break-words text-sm">{u.body}</p>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                )}
              </Card>
            </>
          )}
        </div>

        <aside className="flex flex-col gap-4" aria-label={s('info.title')}>
          <DevTaskBlock
            number={card.number}
            devTask={devTask}
            canManage={canDevelop}
            canHandOver={canDevelop && !devTask && card.status !== 'closed'}
            mode={devTrackerMode()}
            problem={{ actions: { send: problemDevTaskLinkAction, status: problemDevTaskStatusAction, unlink: problemDevTaskUnlinkAction } }}
          />
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6 text-sm">
              <h2 className={label}>{s('info.title')}</h2>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
                <dt className="text-secondary-foreground">{s('info.tickets')}</dt>
                <dd className="tabular-nums" data-testid="problem-ticket-count">{card.ticketCount}</dd>
                <dt className="text-secondary-foreground">{s('info.orgs')}</dt>
                <dd className="tabular-nums">{card.orgCount}</dd>
                <dt className="text-secondary-foreground">{s('info.categories')}</dt>
                <dd>{categories || s('info.never')}</dd>
                <dt className="text-secondary-foreground">{s('info.firstSeen')}</dt>
                <dd>{when(card.firstSeenOn)}</dd>
                <dt className="text-secondary-foreground">{s('info.lastSeen')}</dt>
                <dd>{when(card.lastSeenOn)}</dd>
                <dt className="text-secondary-foreground">{s('info.owner')}</dt>
                <dd className="break-words">{card.ownerName ?? s('info.never')}</dd>
                {card.fixedOn && (
                  <>
                    <dt className="text-secondary-foreground">{s('info.fixedOn')}</dt>
                    <dd>{when(card.fixedOn)}</dd>
                  </>
                )}
                {card.closedOn && (
                  <>
                    <dt className="text-secondary-foreground">{s('info.closedOn')}</dt>
                    <dd>{when(card.closedOn)}</dd>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-2 pt-6 text-sm" data-testid="problem-signatures">
              <h2 className={label}>{s('signatures.title')}</h2>
              {card.signatures.length === 0 && <p className="text-muted-foreground">{s('signatures.none')}</p>}
              <ul className="flex flex-col gap-1">
                {card.signatures.map((row) => (
                  <li key={row.signature} className="flex flex-wrap items-center gap-2">
                    <code className="break-all font-mono text-xs" title={row.signature}>
                      {row.signature.slice(0, 8)}
                    </code>
                    <span>{s('signatures.tickets', { count: row.ticketCount })}</span>
                    {!row.isActive && <span className="text-muted-foreground">{s('signatures.inactive')}</span>}
                    {canWrite && (
                      <form action={removeSignatureAction}>
                        {hidden}
                        <input type="hidden" name="signature" value={row.signature} />
                        <Button type="submit" variant="ghost" size="small">
                          {s('signatures.remove')}
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <form action={addSignatureAction} className="flex flex-col gap-1">
                  {hidden}
                  <Label htmlFor="problem-signature">{card.suggestedSignatures.length > 0 ? s('signatures.addHint') : s('signatures.manual')}</Label>
                  {card.suggestedSignatures.length > 0 ? (
                    <Select id="problem-signature" name="signature">
                      {card.suggestedSignatures.map((row) => (
                        <option key={row.signature} value={row.signature}>
                          {`${row.signature.slice(0, 8)} (${s('signatures.tickets', { count: row.ticketCount })})`}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input id="problem-signature" name="signature" maxLength={32} pattern="[0-9a-fA-F]{32}" required />
                  )}
                  <Button type="submit" variant="secondary" size="small" className="self-start">
                    {s('signatures.add')}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
