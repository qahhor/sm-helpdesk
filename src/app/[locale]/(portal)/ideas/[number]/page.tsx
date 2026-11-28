import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/locales';
import { ideaPage } from '@/modules/hdi/api/board';
import { cycleMonth, ideaRef, parseIdeaNumber } from '@/modules/hdi/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireClientActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { IDEA_STATUS_TONE } from '../../../idea-status';
import { followAction, showOrgAction } from '../actions';
import { VoteButton } from '../VoteButton';
import { IdeaComments } from './IdeaComments';

// Страница идеи (ТЗ 8.3, FR-IDEA-04, 06, 11, 13; план M7, задача 5, решения 2, 5, 6, 7, 11, 13). Заголовок и описание
// выводятся текстом с сохранением переносов, ссылки не становятся нажимаемыми; машинный перевод с пометкой, оригинал
// в один клик через раскрывающийся блок (без скрипта). Автор по имени, организация только при включённом показе.
// Своя идея на модерации: "Изменить" и переключатель показа организации. Невидимая идея: "Не найдено".

type Params = { locale: string; number: string };
type Search = { status?: string; after?: string };

export default async function ClientIdeaPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const client = await requireClientActor();
  const locale = (await getLocale()) as Locale;
  const number = parseIdeaNumber((await params).number);
  if (!number) notFound();
  const idea = await ideaPage(client, { number, locale });
  if (!idea) notFound();
  const t = await getTranslations('client.ideas');
  const format = await getFormatter();
  const search = await searchParams;
  const status = firstParam(search.status) ?? '';
  const modules = idea.moduleId ? await listActiveModules(client.actor, locale) : [];
  const moduleName = modules.find((m) => m.moduleId === idea.moduleId)?.name ?? null;
  const date = (value: string | Date) => format.dateTime(typeof value === 'string' ? new Date(`${value}T12:00:00Z`) : value, { dateStyle: 'long', timeZone: typeof value === 'string' ? 'UTC' : undefined });
  const errorCode = status.startsWith('error-') ? status.slice(6) : null;
  const known = ['rate_limited', 'not_found', 'voting_closed', 'invalid_input', 'not_editable', 'forbidden', 'comments_closed'];

  return (
    <>
      <Link href="/ideas" className="inline-flex min-h-11 items-center self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      {errorCode && <Alert tone="danger">{t(`errors.${known.includes(errorCode) ? errorCode : 'forbidden'}`)}</Alert>}
      {['followed', 'unfollowed', 'saved', 'edited', 'commented', 'comment_held', 'comment_saved'].includes(status) && <Alert tone="success">{t(`page.done.${status}`)}</Alert>}
      <article className="flex flex-col gap-4" data-testid="idea-page">
        <div className="flex gap-3">
          <VoteButton
            number={idea.number}
            voted={idea.voted}
            count={idea.score}
            disabled={!idea.canVote}
            labels={{ vote: t('similar.vote'), voted: t('similar.voted'), count: t.raw('board.votes') as string, error: t('similar.error') }}
          />
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="break-words text-2xl font-bold" lang={idea.text.locale}>
              {idea.text.title}
            </h1>
            <p className="text-sm text-secondary-foreground">
              {ideaRef(idea.number)}
              {moduleName ? ` · ${moduleName}` : ''}
              {' · '}
              {idea.orgName ? t('page.authorOrg', { name: idea.authorName, org: idea.orgName }) : t('page.author', { name: idea.authorName })}
            </p>
            <span className="flex flex-wrap gap-1">
              <StatusLabel tone={IDEA_STATUS_TONE[idea.status]}>{t(`statuses.${idea.status}`)}</StatusLabel>
              {idea.text.isMachine && <StatusLabel tone="gray">{t('machine')}</StatusLabel>}
            </span>
          </div>
        </div>

        {idea.status === 'pending_review' && <Alert tone="info">{t('page.pending')}</Alert>}
        {idea.status === 'merged' && idea.mergedInto && (
          <Alert tone="info">
            {t('page.merged', { ref: ideaRef(idea.mergedInto) })}{' '}
            <Link href={`/ideas/${idea.mergedInto}`} className="text-link underline underline-offset-2" data-testid="merged-target">
              {t('page.openTarget', { ref: ideaRef(idea.mergedInto) })}
            </Link>
          </Alert>
        )}
        {idea.status === 'declined' && (
          <Alert tone="info">
            {t('page.declined')}
            {idea.declineReason && <span className="block whitespace-pre-wrap break-words">{t('page.declineReason', { reason: idea.declineReason })}</span>}
          </Alert>
        )}

        <Card className="flex flex-col gap-3 p-4">
          <p className="whitespace-pre-wrap break-words" lang={idea.text.locale} data-testid="idea-body">
            {idea.text.body}
          </p>
          {idea.translationUnavailable && <p className="text-sm text-secondary-foreground">{t('page.translationUnavailable')}</p>}
          {idea.text.isMachine && (
            <details className="flex flex-col gap-2" data-testid="idea-original">
              <summary className="cursor-pointer text-sm text-link">{t('page.showOriginal')}</summary>
              <div className="mt-2 flex flex-col gap-2 border-s-2 border-border ps-3" lang={idea.original.locale}>
                <p className="break-words font-semibold">{idea.original.title}</p>
                <p className="whitespace-pre-wrap break-words">{idea.original.body}</p>
              </div>
            </details>
          )}
          {idea.attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label={t('page.images')}>
              {idea.attachments.map((file) => (
                <li key={file.attachmentId}>
                  <a href={`/${locale}/ideas/${idea.number}/files/${file.attachmentId}`} target="_blank" rel="noopener noreferrer" className="text-sm text-link underline underline-offset-2">
                    {file.fileName}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <section aria-labelledby="idea-history" className="flex flex-col gap-1 text-sm">
          <h2 id="idea-history" className="font-semibold">
            {t('page.history')}
          </h2>
          <ul className="flex flex-col gap-1 text-secondary-foreground">
            {idea.publishedOn && <li>{t('page.publishedOn', { date: date(idea.publishedOn) })}</li>}
            {idea.selectedCycle && <li>{t('board.selectedIn', { month: format.dateTime(cycleMonth(idea.selectedCycle), { month: 'long', year: 'numeric', timeZone: 'UTC' }) })}</li>}
            {idea.releasedIn && idea.releasedOn && <li>{t('page.releasedOn', { version: idea.releasedIn, date: date(idea.releasedOn) })}</li>}
          </ul>
        </section>

        <div className="flex flex-col gap-3 tablet:flex-row tablet:flex-wrap">
          {(idea.canFollow || idea.subscribed) && (
            <form action={followAction}>
              <input type="hidden" name="number" value={idea.number} />
              <input type="hidden" name="follow" value={idea.subscribed ? '0' : '1'} />
              <Button type="submit" variant="secondary" aria-pressed={idea.subscribed}>
                {idea.subscribed ? t('page.unfollow') : t('page.follow')}
              </Button>
            </form>
          )}
          {idea.canEdit && (
            <Button asChild variant="secondary">
              <Link href={`/ideas/${idea.number}/edit`}>{t('page.edit')}</Link>
            </Button>
          )}
        </div>

        {idea.isAuthor && (
          <form action={showOrgAction} className="flex flex-col gap-2 rounded-card border border-border bg-card p-4">
            <input type="hidden" name="number" value={idea.number} />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="showOrg" defaultChecked={idea.showOrg} className="size-4 accent-primary" />
              <span>{t('new.showOrg')}</span>
            </label>
            <p className="text-sm text-secondary-foreground">{t('new.showOrgHint')}</p>
            <Button type="submit" variant="secondary" size="small" className="self-start">
              {t('page.save')}
            </Button>
          </form>
        )}

        <IdeaComments actor={client.actor} number={idea.number} after={firstParam(search.after)} canComment={idea.status !== 'declined' && idea.status !== 'merged'} />
      </article>
    </>
  );
}
