import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { BOARD_QUERY_MAX, IDEA_STATUSES, type IdeaStatus, ideaRef } from '@/modules/hdi/api/constants';
import { isHdiError } from '@/modules/hdi/api/errors';
import { type PendingComment, pendingComments } from '@/modules/hdi/api/comments';
import { type StaffIdeaListRow, staffIdeaList } from '@/modules/hdi/api/staff';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { IDEA_STATUS_TONE } from '../../../idea-status';

// Идеи на рабочем месте (ТЗ 8.11, FR-IDEA-15; план M7, задача 6), образец "Список": вкладки "Модерация" (от старых к
// новым), "Все" (фильтры статуса, модуля, организации и поиск по заголовку обычной формой GET). Организация автора
// видна сотрудникам всегда. Таблица прокручивается вбок внутри карточки, страница нет (360, 768, 1280).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = ['moderation', 'all', 'comments'] as const;
type Tab = (typeof TABS)[number];
type Search = { tab?: string; status?: string; module?: string; org?: string; q?: string; after?: string };

export default async function AgentIdeasPage({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.ideas');
  const ci = await getTranslations('client.ideas');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(firstParam(search.tab) ?? '') ? (firstParam(search.tab) as Tab) : 'moderation';
  const status = (IDEA_STATUSES as readonly string[]).includes(firstParam(search.status) ?? '') ? (firstParam(search.status) as IdeaStatus) : undefined;
  const moduleId = UUID.test(firstParam(search.module) ?? '') ? firstParam(search.module) : undefined;
  const org = (firstParam(search.org) ?? '').trim().slice(0, BOARD_QUERY_MAX);
  const q = (firstParam(search.q) ?? '').trim().slice(0, BOARD_QUERY_MAX);
  const after = Number(firstParam(search.after));
  let page: { items: StaffIdeaListRow[]; next: number | null } = { items: [], next: null };
  const comments: PendingComment[] = tab === 'comments' ? await pendingComments(staff) : [];
  try {
    if (tab !== 'comments')
      page = await staffIdeaList(
      staff,
      tab === 'moderation'
        ? { tab }
        : { tab, ...(status ? { status } : {}), ...(moduleId ? { moduleId } : {}), ...(org ? { org } : {}), ...(q ? { q } : {}), ...(Number.isSafeInteger(after) && after > 0 ? { after } : {}) },
    );
  } catch (error) {
    if (!isHdiError(error)) throw error;
  }
  const modules = await listActiveModules(staff.actor, locale);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const next =
    page.next !== null
      ? `/agent/ideas?${new URLSearchParams({ tab, ...(status ? { status } : {}), ...(moduleId ? { module: moduleId } : {}), ...(org ? { org } : {}), ...(q ? { q } : {}), after: String(page.next) })}`
      : null;

  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        <nav aria-label={s('tabsLabel')} className="flex flex-wrap gap-2">
          {TABS.map((value) => (
            <Link
              key={value}
              href={`/agent/ideas?tab=${value}`}
              aria-current={value === tab ? 'page' : undefined}
              className={`inline-flex min-h-control items-center rounded-chip border px-4 text-sm font-medium ${value === tab ? 'border-primary bg-selected text-selected-foreground' : 'border-border bg-card text-foreground hover:bg-card-soft'}`}
            >
              {s(`tabs.${value}`)}
            </Link>
          ))}
        </nav>
        {tab === 'all' && (
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
            <input type="hidden" name="tab" value="all" />
            <div className="flex flex-col gap-1">
              <Label htmlFor="ideas-status">{s('filters.status')}</Label>
              <Select id="ideas-status" name="status" defaultValue={status ?? ''}>
                <option value="">{s('filters.any')}</option>
                {IDEA_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {ci(`statuses.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ideas-module">{s('filters.module')}</Label>
              <Select id="ideas-module" name="module" defaultValue={moduleId ?? ''}>
                <option value="">{s('filters.any')}</option>
                {modules.map((m) => (
                  <option key={m.moduleId} value={m.moduleId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ideas-org">{s('filters.org')}</Label>
              <Input id="ideas-org" name="org" maxLength={BOARD_QUERY_MAX} defaultValue={org} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ideas-q">{s('filters.q')}</Label>
              <Input id="ideas-q" name="q" type="search" maxLength={BOARD_QUERY_MAX} defaultValue={q} />
            </div>
            <Button type="submit" variant="secondary">
              {s('filters.apply')}
            </Button>
          </form>
        )}
        {tab === 'comments' ? (
          comments.length === 0 ? (
            <Card>
              <EmptyState title={s('empty.comments')} text={s('emptyText')} />
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={s('tabs.comments')} data-testid="agent-idea-comments">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    {(['idea', 'author', 'text', 'created'] as const).map((column) => (
                      <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                        {s(`comments.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comments.map((c) => (
                    <tr key={c.commentId} className="border-b border-border align-top last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-3">
                        <Link href={`/agent/ideas/${c.ideaNumber}#idea-comments`} className="text-link underline underline-offset-2">
                          {ideaRef(c.ideaNumber)}
                        </Link>
                      </td>
                      <td className="px-3 py-3">{c.authorName}</td>
                      <td className="whitespace-pre-wrap break-words px-3 py-3">{c.body}</td>
                      <td className="whitespace-nowrap px-3 py-3">{format.dateTime(c.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        ) : page.items.length === 0 ? (
          <Card>
            <EmptyState title={s(`empty.${tab}`)} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s(`tabs.${tab}`)} data-testid="agent-ideas">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['number', 'title', 'org', 'module', 'status', 'votes', 'comments', 'created'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={row.ideaId} data-idea={row.number} className="border-b border-border align-top last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums">{ideaRef(row.number)}</td>
                    <th scope="row" className="px-3 py-3 text-start font-normal">
                      <Link href={`/agent/ideas/${row.number}`} className="break-words font-semibold text-link underline-offset-2 hover:underline" lang={row.locale}>
                        {row.title}
                      </Link>
                      <span className="block text-secondary-foreground">{row.authorName}</span>
                    </th>
                    <td className="px-3 py-3">{row.orgName}</td>
                    <td className="px-3 py-3">{row.moduleId ? (moduleName.get(row.moduleId) ?? '') : ''}</td>
                    <td className="px-3 py-3">
                      <StatusLabel tone={IDEA_STATUS_TONE[row.status]}>{ci(`statuses.${row.status}`)}</StatusLabel>
                    </td>
                    <td className="px-3 py-3 tabular-nums">{s('votesCell', { votes: row.voteCount, orgs: row.orgCount })}</td>
                    <td className="px-3 py-3 tabular-nums">{format.number(row.commentCount)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{format.dateTime(row.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {next && (
          <Link href={next} className="self-center text-link underline-offset-2 hover:underline">
            {s('more')}
          </Link>
        )}
      </div>
    </>
  );
}
