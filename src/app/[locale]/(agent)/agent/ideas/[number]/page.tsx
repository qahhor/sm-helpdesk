import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LOCALES } from '@/i18n/locales';
import { DECLINE_REASON_MAX, IDEA_BODY_MAX, IDEA_TITLE_MAX, ideaRef, parseIdeaNumber, RELEASE_VERSION_MAX, tashkentDate } from '@/modules/hdi/api/constants';
import { DEV_TASK_REF_MAX, DEV_TASK_TITLE_MAX, DEV_TASK_URL_MAX, devTrackerMode } from '@/modules/hdw/api';
import { staffIdeaCard } from '@/modules/hdi/api/staff';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { IDEA_STATUS_TONE } from '../../../../idea-status';
import { StaffComments } from './StaffComments';
import { declineIdeaAction, editIdeaAction, mergeIdeaAction, publishIdeaAction, releaseIdeaAction, reviewTranslationAction, sendIdeaToDevelopmentAction } from '../actions';

// Карточка идеи на рабочем месте (ТЗ FR-IDEA-03, 13, 15; план M7, задача 6, решения 5, 6, 9, 11, 24). Тексты клиента
// (заголовок, описание, переводы) выводятся только текстовыми узлами с сохранением переносов: ни разметки, ни
// нажимаемых ссылок (решение 13). Организация автора видна всегда. Модерация, правка, переводы и разбивка голосов по
// организациям и категориям только у product и admin; имён голосовавших нет ни у кого. Выбранная идея передаётся в
// разработку тем же адаптером, что обращения, "Выпущена" ставится с версией и датой (задача 9, решение 18).

const ERRORS = [
  'forbidden',
  'invalid_input',
  'not_found',
  'bad_transition',
  'bad_merge_target',
  'findings_unchecked',
  'not_editable',
  'comments_closed',
  'rate_limited',
  'invalid_url',
  'already_linked',
  'task_closed',
  'task_not_found',
  'tracker_unavailable',
];

export default async function AgentIdeaPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ status?: string; after?: string }> }) {
  const staff = await requireStaffActor();
  const number = parseIdeaNumber((await params).number);
  if (!number) notFound();
  const card = await staffIdeaCard(staff, { number });
  if (!card) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.ideas');
  const ci = await getTranslations('client.ideas');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const status = firstParam(search.status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const modules = await listActiveModules(staff.actor, locale);
  const original = card.texts.find((text) => text.status === 'original');
  const translations = card.texts.filter((text) => text.status !== 'original');
  const missing = LOCALES.filter((l) => l !== original?.locale && !translations.some((text) => text.locale === l));
  const pending = card.status === 'pending_review';
  const blocking = card.findings.filter((kind) => ['phone', 'email', 'inn', 'pinfl', 'server'].includes(kind));
  const trackerMode = devTrackerMode();
  // Дата выпуска по умолчанию: сегодня по Ташкенту.
  const today = tashkentDate(new Date());

  return (
    <>
      <PageHeader
        title={`${ideaRef(card.number)} ${original?.title ?? ''}`}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/ideas' }, { label: ideaRef(card.number) }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4" data-testid="agent-idea">
        {code && <Alert tone="danger">{s(`errors.${ERRORS.includes(code) ? code : 'forbidden'}`)}</Alert>}
        {['published', 'declined', 'merged', 'edited', 'translation', 'comment_hidden', 'comment_published', 'replied', 'in_development', 'released'].includes(status) && (
          <Alert tone="success">{s(`done.${status}`)}</Alert>
        )}

        <Card>
          <CardContent className="flex flex-col gap-2 pt-4">
            <span className="flex flex-wrap gap-1">
              <StatusLabel tone={IDEA_STATUS_TONE[card.status]}>{ci(`statuses.${card.status}`)}</StatusLabel>
              {card.findingsChecked && <StatusLabel tone="green">{s('findingsChecked')}</StatusLabel>}
            </span>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm tablet:grid-cols-2">
              <dt className="text-secondary-foreground">{s('fields.author')}</dt>
              <dd>{card.authorName}</dd>
              <dt className="text-secondary-foreground">{s('fields.org')}</dt>
              <dd>
                {card.orgName} {!card.showOrg && <span className="text-secondary-foreground">({s('fields.orgHidden')})</span>}
              </dd>
              <dt className="text-secondary-foreground">{s('fields.votes')}</dt>
              <dd className="tabular-nums">{s('votesCell', { votes: card.voteCount, orgs: card.orgCount })}</dd>
              <dt className="text-secondary-foreground">{s('fields.created')}</dt>
              <dd>{format.dateTime(card.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
              {card.publishedOn && (
                <>
                  <dt className="text-secondary-foreground">{s('fields.published')}</dt>
                  <dd>{format.dateTime(card.publishedOn, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
                </>
              )}
              {card.mergedInto && (
                <>
                  <dt className="text-secondary-foreground">{s('fields.mergedInto')}</dt>
                  <dd>
                    <Link href={`/agent/ideas/${card.mergedInto}`} className="text-link underline underline-offset-2">
                      {ideaRef(card.mergedInto)}
                    </Link>
                  </dd>
                </>
              )}
              {card.declineReason && (
                <>
                  <dt className="text-secondary-foreground">{s('fields.declineReason')}</dt>
                  <dd className="whitespace-pre-wrap break-words">{card.declineReason}</dd>
                </>
              )}
            </dl>
            {card.findings.length > 0 && (
              <Alert tone={blocking.length > 0 && !card.findingsChecked ? 'danger' : 'info'}>
                {s('findings', { kinds: card.findings.map((kind) => ci(`new.findings.${kind}`)).join(', ') })}
              </Alert>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 laptop:grid-cols-2">
          {original && (
            <Card>
              <CardHeader>
                <h2 className="text-lg font-semibold">{s('original', { locale: original.locale.toUpperCase() })}</h2>
              </CardHeader>
              <CardContent className="flex flex-col gap-2" lang={original.locale}>
                <p className="break-words font-semibold" data-testid="agent-idea-title">
                  {original.title}
                </p>
                <p className="whitespace-pre-wrap break-words" data-testid="agent-idea-body">
                  {original.body}
                </p>
              </CardContent>
            </Card>
          )}
          {translations.map((text) => (
            <Card key={text.locale}>
              <CardHeader>
                <h2 className="text-lg font-semibold">
                  {s('translation', { locale: text.locale.toUpperCase() })} <StatusLabel tone={text.status === 'reviewed' ? 'green' : text.status === 'machine' ? 'blue' : 'danger'}>{s(`textStatuses.${text.status}`)}</StatusLabel>
                </h2>
              </CardHeader>
              <CardContent className="flex flex-col gap-2" lang={text.locale}>
                {card.canModerate && !pending && card.status !== 'declined' && card.status !== 'merged' ? (
                  <form action={reviewTranslationAction} className="flex flex-col gap-2">
                    <input type="hidden" name="number" value={card.number} />
                    <input type="hidden" name="locale" value={text.locale} />
                    <Label htmlFor={`tr-title-${text.locale}`}>{s('fields.title')}</Label>
                    <Input id={`tr-title-${text.locale}`} name="title" required maxLength={IDEA_TITLE_MAX * 2} defaultValue={text.title} />
                    <Label htmlFor={`tr-body-${text.locale}`}>{s('fields.body')}</Label>
                    <Textarea id={`tr-body-${text.locale}`} name="body" required rows={6} maxLength={IDEA_BODY_MAX * 2} defaultValue={text.body} />
                    <Button type="submit" variant="secondary" size="small" className="self-start">
                      {s('actions.reviewTranslation')}
                    </Button>
                  </form>
                ) : (
                  <>
                    <p className="break-words font-semibold">{text.title}</p>
                    <p className="whitespace-pre-wrap break-words">{text.body}</p>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
          {missing.length > 0 && !pending && <p className="text-sm text-secondary-foreground">{s('noTranslation', { locales: missing.map((l) => l.toUpperCase()).join(', ') })}</p>}
        </div>

        {card.attachments.length > 0 && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('images')}</h2>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1">
                {card.attachments.map((file) => (
                  <li key={file.attachmentId}>
                    {file.scanStatus === 'clean' ? (
                      <a href={`/${locale}/agent/ideas/${card.number}/files/${file.attachmentId}`} target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2">
                        {file.fileName}
                      </a>
                    ) : (
                      <span>
                        {file.fileName} ({s(`scan.${file.scanStatus}`)})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {card.breakdown && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('breakdown.title')}</h2>
              <p className="text-sm text-secondary-foreground">{s('breakdown.intro')}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 overflow-x-auto">
              <p className="text-sm" data-testid="breakdown-categories">
                {(['A', 'B', 'C', 'D'] as const).map((c) => `${c}: ${card.breakdown?.categories[c] ?? 0}`).join(' · ')} · {s('breakdown.none')}: {card.breakdown.categories.none}
              </p>
              {card.breakdown.orgs.length > 0 && (
                <table className="w-full text-sm" data-testid="breakdown-orgs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {s('breakdown.org')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {s('breakdown.category')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">
                        {s('breakdown.votes')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.breakdown.orgs.map((row) => (
                      <tr key={row.orgId} className="border-b border-border last:border-b-0">
                        <th scope="row" className="px-3 py-2 text-start font-normal">
                          {row.name}
                        </th>
                        <td className="px-3 py-2">{row.category ?? s('breakdown.none')}</td>
                        <td className="px-3 py-2 tabular-nums">{row.votes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {card.devTask && (
          <Card data-testid="idea-dev-task">
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('dev.title')}</h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <p>
                <a href={card.devTask.url} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline underline-offset-2">
                  {card.devTask.externalId}
                </a>
                {card.devTask.title ? ` ${card.devTask.title}` : ''}
              </p>
              <p>
                {s('dev.status')}: {t(`ticket.devTask.statuses.${card.devTask.status}`)}
                {card.devTask.version ? ` · ${s('dev.version', { version: card.devTask.version })}` : ''}
              </p>
            </CardContent>
          </Card>
        )}

        {card.canModerate && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('actions.title')}</h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {card.transitions.includes('open') && (
                <form action={publishIdeaAction} className="flex flex-col gap-2">
                  <input type="hidden" name="number" value={card.number} />
                  {blocking.length > 0 && !card.findingsChecked && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="findingsChecked" className="size-4 accent-primary" />
                      <span>{s('actions.findingsChecked')}</span>
                    </label>
                  )}
                  <Button type="submit" className="self-start">
                    {s('actions.publish')}
                  </Button>
                </form>
              )}
              {pending && original && (
                <form action={editIdeaAction} className="flex flex-col gap-2">
                  <input type="hidden" name="number" value={card.number} />
                  <Label htmlFor="edit-title">{s('fields.title')}</Label>
                  <Input id="edit-title" name="title" required maxLength={IDEA_TITLE_MAX} defaultValue={original.title} />
                  <Label htmlFor="edit-body">{s('fields.body')}</Label>
                  <Textarea id="edit-body" name="body" required rows={6} maxLength={IDEA_BODY_MAX} defaultValue={original.body} />
                  <Label htmlFor="edit-module">{s('filters.module')}</Label>
                  <Select id="edit-module" name="moduleId" defaultValue={card.moduleId ?? ''}>
                    <option value="">{s('filters.any')}</option>
                    {modules.map((m) => (
                      <option key={m.moduleId} value={m.moduleId}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit" variant="secondary" className="self-start">
                    {s('actions.edit')}
                  </Button>
                </form>
              )}
              {card.transitions.includes('merged') && (
                <form action={mergeIdeaAction} className="flex flex-col gap-2">
                  <input type="hidden" name="number" value={card.number} />
                  <Label htmlFor="merge-into">{s('actions.mergeInto')}</Label>
                  <Input id="merge-into" name="into" required placeholder="I-204" />
                  <Button type="submit" variant="secondary" className="self-start">
                    {s('actions.merge')}
                  </Button>
                </form>
              )}
              {card.status === 'selected' && !card.devTask && (
                <form action={sendIdeaToDevelopmentAction} className="flex flex-col gap-2" data-testid="idea-send-dev">
                  <input type="hidden" name="number" value={card.number} />
                  <p className="font-semibold">{s('dev.send')}</p>
                  {trackerMode === 'manual' ? (
                    <>
                      <Label htmlFor="dev-ref">{s('dev.ref')}</Label>
                      <Input id="dev-ref" name="externalId" required maxLength={DEV_TASK_REF_MAX} placeholder="DEV-501" />
                      <Label htmlFor="dev-url">{s('dev.url')}</Label>
                      <Input id="dev-url" name="url" type="url" required maxLength={DEV_TASK_URL_MAX} placeholder="https://" />
                      <Label htmlFor="dev-title">{s('dev.taskTitle')}</Label>
                      <Input id="dev-title" name="title" required maxLength={DEV_TASK_TITLE_MAX} defaultValue={original?.title.slice(0, DEV_TASK_TITLE_MAX) ?? ''} />
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-secondary-foreground">{s('dev.apiHint')}</p>
                      <Label htmlFor="dev-ref">{s('dev.refOptional')}</Label>
                      <Input id="dev-ref" name="externalId" maxLength={DEV_TASK_REF_MAX} />
                    </>
                  )}
                  <Button type="submit" className="self-start">
                    {s('dev.submit')}
                  </Button>
                </form>
              )}
              {card.transitions.includes('released') && (
                <form action={releaseIdeaAction} className="flex flex-col gap-2" data-testid="idea-release">
                  <input type="hidden" name="number" value={card.number} />
                  <p className="font-semibold">{s('dev.release')}</p>
                  <Label htmlFor="release-version">{s('dev.releaseVersion')}</Label>
                  <Input id="release-version" name="version" required maxLength={RELEASE_VERSION_MAX} defaultValue={card.devTask?.version ?? ''} />
                  <Label htmlFor="release-date">{s('dev.releaseDate')}</Label>
                  <Input id="release-date" name="releasedOn" type="date" required defaultValue={today} />
                  <Button type="submit" className="self-start">
                    {s('dev.releaseSubmit')}
                  </Button>
                </form>
              )}
              {card.transitions.includes('declined') && (
                <form action={declineIdeaAction} className="flex flex-col gap-2">
                  <input type="hidden" name="number" value={card.number} />
                  <Label htmlFor="decline-reason">{s('actions.declineReason')}</Label>
                  <Textarea id="decline-reason" name="reason" required rows={3} maxLength={DECLINE_REASON_MAX} />
                  <Button type="submit" variant="secondary" className="self-start">
                    {s('actions.decline')}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        )}

        <StaffComments
          actor={staff.actor}
          number={card.number}
          after={firstParam(search.after)}
          canModerate={card.canModerate}
          canReply={card.status !== 'pending_review' && card.status !== 'declined' && card.status !== 'merged'}
        />
      </div>
    </>
  );
}
