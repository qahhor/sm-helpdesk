import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/locales';
import { listIdeas, type BoardCard } from '@/modules/hdi/api/board';
import { BOARD_QUERY_MAX, BOARD_TABS, type BoardTab, cycleCountdown, cycleMonth, ideaRef } from '@/modules/hdi/api/constants';
import { isHdiError } from '@/modules/hdi/api/errors';
import { listActiveModules } from '@/modules/hdr/api';
import { requireClientActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { IDEA_STATUS_TONE } from '../../idea-status';
import { VoteButton } from './VoteButton';

// Доска идей (ТЗ 8.3 "Биржа идей", FR-IDEA-14; план M7, задача 5, решение 22): вкладки "Популярные", "Новые",
// "В работе", "Выпущенные", фильтр модуля и поиск обычной формой GET (работают без скриптов), строка обратного отсчёта
// до отбора месяца, карточки со счётчиком, статусом и отметкой "Вы проголосовали", следующая страница по ключу.
// Скрипт на странице только у кнопки голоса.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Search = { tab?: string; module?: string; q?: string; after?: string };

export default async function ClientIdeasPage({ searchParams }: { searchParams: Promise<Search> }) {
  const client = await requireClientActor();
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations('client.ideas');
  const format = await getFormatter();
  const search = await searchParams;
  const tab: BoardTab = (BOARD_TABS as readonly string[]).includes(firstParam(search.tab) ?? '') ? (firstParam(search.tab) as BoardTab) : 'popular';
  const moduleId = UUID.test(firstParam(search.module) ?? '') ? firstParam(search.module) : undefined;
  const q = (firstParam(search.q) ?? '').trim().slice(0, BOARD_QUERY_MAX);
  const after = Number(firstParam(search.after));
  let page: { items: BoardCard[]; next: number | null } = { items: [], next: null };
  let limited = false;
  try {
    page = await listIdeas(client, { tab, locale, ...(moduleId ? { moduleId } : {}), ...(q ? { q } : {}), ...(Number.isSafeInteger(after) && after > 0 ? { after } : {}) });
  } catch (error) {
    if (!isHdiError(error)) throw error;
    limited = error.code === 'rate_limited';
  }
  const modules = await listActiveModules(client.actor, locale);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const countdown = cycleCountdown(new Date());
  const query = (extra: Record<string, string>) => `?${new URLSearchParams({ ...(tab !== 'popular' ? { tab } : {}), ...(moduleId ? { module: moduleId } : {}), ...(q ? { q } : {}), ...extra })}`;
  const voteLabels = { vote: t('similar.vote'), voted: t('similar.voted'), count: t.raw('board.votes') as string, error: t('similar.error') };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('board.title')}</h1>
        <Button asChild>
          <Link href="/ideas/new">{t('board.new')}</Link>
        </Button>
      </div>
      <nav aria-label={t('board.tabsLabel')} className="flex flex-wrap gap-2">
        {BOARD_TABS.map((value) => (
          <Link
            key={value}
            href={`/ideas${value === 'popular' ? '' : `?tab=${value}`}`}
            aria-current={value === tab ? 'page' : undefined}
            className={`inline-flex min-h-control items-center rounded-chip border px-4 text-sm font-medium ${value === tab ? 'border-primary bg-selected text-selected-foreground' : 'border-border bg-card text-foreground hover:bg-card-soft'}`}
          >
            {t(`board.tabs.${value}`)}
          </Link>
        ))}
      </nav>
      <form method="get" className="grid grid-cols-1 gap-3 tablet:grid-cols-2 tablet:items-end">
        {tab !== 'popular' && <input type="hidden" name="tab" value={tab} />}
        <div className="flex flex-col gap-1">
          <Label htmlFor="ideas-module">{t('board.module')}</Label>
          <Select id="ideas-module" name="module" defaultValue={moduleId ?? ''}>
            <option value="">{t('board.moduleAll')}</option>
            {modules.map((m) => (
              <option key={m.moduleId} value={m.moduleId}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ideas-q">{t('board.search')}</Label>
          <div className="flex gap-2">
            <Input id="ideas-q" name="q" type="search" maxLength={BOARD_QUERY_MAX} defaultValue={q} />
            <Button type="submit" variant="secondary">
              {t('board.find')}
            </Button>
          </div>
        </div>
      </form>
      <p className="flex flex-wrap justify-between gap-2 rounded-card border border-border bg-card-soft px-4 py-3 text-sm" data-testid="cycle-countdown">
        <span>{t('board.countdown', { month: format.dateTime(countdown.month, { month: 'long', timeZone: 'UTC' }), days: countdown.daysLeft })}</span>
        <Link href="/ideas/cycles" className="inline-flex min-h-11 items-center text-link underline underline-offset-2">
          {t('cycles.link')}
        </Link>
      </p>
      {limited && <Alert tone="danger">{t('errors.rate_limited')}</Alert>}
      {page.items.length === 0 ? (
        <Card>
          <EmptyState title={q || moduleId ? t('board.notFound') : t('emptyTitle')} text={q || moduleId ? t('board.notFoundText') : t('emptyText')} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="ideas-board">
          {page.items.map((item) => (
            <li key={item.number} data-idea={item.number} className="flex gap-3 rounded-card border border-border bg-card p-3">
              <VoteButton number={item.number} voted={item.voted} count={item.score} disabled={item.status !== 'open' && item.status !== 'shortlisted'} labels={voteLabels} />
              <div className="flex min-w-0 flex-col gap-1">
                <Link href={`/ideas/${item.number}`} className="inline-flex min-h-11 items-center break-words font-semibold text-link underline-offset-2 hover:underline">
                  {item.title}
                </Link>
                <p className="text-sm text-secondary-foreground">
                  {ideaRef(item.number)}
                  {item.moduleId && moduleName.has(item.moduleId) ? ` · ${moduleName.get(item.moduleId)}` : ''}
                  {` · ${t('board.comments', { count: item.commentCount })}`}
                  {item.isMachine ? ` · ${t('machine')}` : ''}
                </p>
                <span className="flex flex-wrap gap-1">
                  <StatusLabel tone={IDEA_STATUS_TONE[item.status]}>
                    {item.status === 'selected' && item.selectedCycle
                      ? t('board.selectedIn', { month: format.dateTime(cycleMonth(item.selectedCycle), { month: 'long', year: 'numeric', timeZone: 'UTC' }) })
                      : item.status === 'released' && item.releasedIn
                        ? t('board.releasedIn', { version: item.releasedIn })
                        : t(`statuses.${item.status}`)}
                  </StatusLabel>
                  {item.voted && <StatusLabel tone="green">{t('similar.voted')}</StatusLabel>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.next !== null && (
        <Link href={`/ideas${query({ after: String(page.next) })}`} className="inline-flex min-h-11 items-center self-center text-link underline-offset-2 hover:underline">
          {t('board.more')}
        </Link>
      )}
    </>
  );
}
