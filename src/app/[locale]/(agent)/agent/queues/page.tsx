import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import {
  defaultQueueSort,
  HDT_ERROR_CODES,
  listQueue,
  QUEUE_KEYS,
  QUEUE_SORTS,
  queueHref,
  type QueueKey,
  queueSidebar,
  type QueueSort,
  type QueueTarget,
  TRANSFER_REASONS,
} from '@/modules/hdt/api';
import { listTags } from '@/modules/hdr/api';
import { listAssignableStaff, requireStaffActor } from '@/modules/hdu/api';
import { TagChip } from '@/ui/agent/TagChip';
import { SlaBadge, slaLabelKey } from '@/ui/agent/SlaBadge';
import { Alert } from '@/ui/components/alert';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { cn } from '@/ui/cn';
import { saveFilterAction } from './actions';
import { BULK_FORM_ID, BulkBar } from './BulkBar';
import { HDP_ERROR_CODES } from '@/modules/hdp/api';
import { QueueNav } from './QueueNav';
import { QueuePreview } from './QueuePreview';
import { QueueKeys } from './QueueKeys';

// Очереди рабочего места (FR-AG-01, FR-AG-10, FR-AG-14, FR-AG-18, UX-A-08, UX-A-09; экран 8.4 "Очередь").
// Слева очереди со счётчиками и сохранённые списки, справа поиск, сортировка и таблица по ближайшему сроку.

type Search = { queue?: string; sort?: string; q?: string; tag?: string; page?: string; after?: string; done?: string; error?: string; open?: string };
/** Ключ листания: время изменения с микросекундами и идентификатор обращения. Иное значение из адреса не берётся. */
const AFTER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Тег в адресе: идентификатор из справочника. Иное значение не берётся. */
const TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2 align-top';

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

export default async function QueuesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const params = await searchParams;
  const queue = pick<QueueKey>(params.queue, QUEUE_KEYS, 'new');
  // "Все" по умолчанию по последнему изменению: по сроку вперёд вышли бы давно закрытые обращения, а сортировка
  // всей базы без индекса медленная (аудит 23.11.2026, находка P2).
  const sort = pick<QueueSort>(params.sort, QUEUE_SORTS, defaultQueueSort(queue));
  const sortChosen = QUEUE_SORTS.some((key) => key === params.sort);
  const q = params.q?.trim() ? params.q.trim().slice(0, 200) : undefined;
  const page = Math.max(1, Math.min(1000, Number(params.page) || 1));
  // Очередь по последнему изменению листается по ключу последней строки, остальные по номеру страницы.
  const after = sort === 'updated' && params.after && AFTER.test(params.after) && !Number.isNaN(Date.parse(`${params.after.slice(0, 23)}Z`)) ? params.after : undefined;
  const canWrite = staff.actor.staffRole !== 'product';
  // Фильтр по тегу (FR-AUTO-13): выбирается в очереди "Все", листание его сохраняет.
  const tag = params.tag && TAG.test(params.tag) ? params.tag : undefined;
  const [list, sidebar, tags, assignable] = await Promise.all([
    listQueue(staff, { queue, sort, q, tag, ...(after ? { after } : { page }) }),
    queueSidebar(staff),
    listTags(staff),
    canWrite ? listAssignableStaff(staff) : Promise.resolve([]),
  ]);
  const { counts, filters, unidentified } = sidebar;
  const locale = await getLocale();
  const openNumber = Number(params.open) > 0 && Number.isInteger(Number(params.open)) ? Number(params.open) : null;
  const href = (next: QueueTarget) => queueHref({ queue, sort, sortChosen, q, tag }, next);
  const slaText = (minutesLeft: number | null) => {
    const label = slaLabelKey(minutesLeft);
    return t(`queues.sla.${label.key}`, { value: label.value });
  };

  return (
    <>
      <PageHeader
        title={t('queues.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('queues.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          canWrite ? (
            <Link href="/agent/tickets/new" className={buttonVariants({ variant: 'secondary' })}>
              {t('newTicket.open')}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 laptop:flex-row laptop:items-start">
        <QueueNav location={{ queue, sort, sortChosen, q, tag }} counts={counts} filters={filters} unidentified={unidentified} />

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {params.done === 'filter_saved' && <Alert tone="success">{t('queues.done.filterSaved')}</Alert>}
          {params.done === 'queue_done' && <Alert tone="info">{t('queues.done.queue_done')}</Alert>}
          {params.error === 'filter_invalid' && <Alert tone="danger">{t('queues.errors.filterInvalid')}</Alert>}
          <form method="get" className="flex flex-wrap items-end gap-2" role="search">
            <input type="hidden" name="queue" value={queue} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="queue-q" className="text-sm font-medium">
                {t('queues.search')}
              </label>
              <Input id="queue-q" name="q" defaultValue={q ?? ''} placeholder={t('queues.searchHint')} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="queue-sort" className="text-sm font-medium">
                {t('queues.sort')}
              </label>
              <Select id="queue-sort" name="sort" defaultValue={sort}>
                {QUEUE_SORTS.map((key) => (
                  <option key={key} value={key}>
                    {t(`queues.sorts.${key}`)}
                  </option>
                ))}
              </Select>
            </div>
            {(queue === 'all' || tag) && tags.length > 0 && (
              <div className="flex flex-col gap-1">
                <label htmlFor="queue-tag" className="text-sm font-medium">
                  {t('queues.tag')}
                </label>
                <Select id="queue-tag" name="tag" defaultValue={tag ?? ''}>
                  <option value="">{t('queues.anyTag')}</option>
                  {tags.map((item) => (
                    <option key={item.tagId} value={item.tagId}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Button type="submit">{t('queues.show')}</Button>
          </form>

          {list.searchTruncated && <Alert tone="info">{t('queues.searchTruncated')}</Alert>}
          {list.items.length === 0 ? (
            <Card>
              <EmptyState title={t('queues.emptyTitle')} text={list.searchTooShort ? t('queues.searchTooShort') : q || tag ? t('queues.emptySearch') : t('queues.emptyText')} />
            </Card>
          ) : (
            <>
            {canWrite && (
              <BulkBar
                staff={assignable.map((person) => ({ value: person.userId, label: person.name }))}
                reasons={TRANSFER_REASONS.map((value) => ({ value, label: t(`ticket.transfer.reasons.${value}`) }))}
                labels={{
                  title: t('queues.bulk.title'),
                  action: t('queues.bulk.action'),
                  actions: {
                    assign: t('queues.bulk.actions.assign'),
                    queue_l2: t('queues.bulk.actions.queue_l2'),
                    queue_l1: t('queues.bulk.actions.queue_l1'),
                    duplicate: t('queues.bulk.actions.duplicate'),
                    link_problem: t('queues.bulk.actions.link_problem'),
                  },
                  assignee: t('ticket.controls.assignee'),
                  unassigned: t('queues.unassigned'),
                  reason: t('ticket.transfer.reason'),
                  reasonHint: t('ticket.transfer.reasonHint'),
                  checked: t('ticket.transfer.checked'),
                  needed: t('ticket.transfer.needed'),
                  explanation: t('ticket.return.explanation'),
                  into: t('ticket.merge.into'),
                  problem: t('queues.bulk.problem'),
                  submit: t('queues.bulk.submit'),
                  done: t.raw('queues.bulk.done') as string,
                  refused: t.raw('queues.bulk.refused') as string,
                  errors: Object.fromEntries([...HDT_ERROR_CODES.filter((code) => t.has(`ticket.controls.errors.${code}`)).map((code) => [code, t(`ticket.controls.errors.${code}`)]), ['invalid_input', t('queues.bulk.invalid')], ...HDP_ERROR_CODES.map((code) => [`problem_${code}`, t(`problems.errors.${code}`, { kinds: '' })])]),
                }}
              />
            )}
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t(`queues.names.${queue}`)}</caption>
                <thead>
                  <tr className="border-b border-border">
                    {canWrite && (
                      <th scope="col" className={head}>
                        <span className="sr-only">{t('queues.bulk.selectColumn')}</span>
                      </th>
                    )}
                    <th scope="col" className={head}>{t('queues.columns.number')}</th>
                    <th scope="col" className={head}>{t('queues.columns.title')}</th>
                    <th scope="col" className={head}>{t('queues.columns.client')}</th>
                    <th scope="col" className={head}>{t('queues.columns.priority')}</th>
                    <th scope="col" className={head}>{t('queues.columns.sla')}</th>
                    <th scope="col" className={head}>{t('queues.columns.assignee')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((row) => (
                    <tr key={row.number} className="border-b border-border last:border-0" data-number={row.number}>
                      {canWrite && (
                        <td className={cell}>
                          <input
                            type="checkbox"
                            name="numbers"
                            value={row.number}
                            form={BULK_FORM_ID}
                            className="size-5 accent-primary"
                            aria-label={t('queues.bulk.select', { number: `SUP-${row.number}` })}
                          />
                        </td>
                      )}
                      <td className={cn(cell, 'whitespace-nowrap')}>
                        <Link
                          href={`/agent/tickets/SUP-${row.number}?queue=${queue}&sort=${sort}`}
                          className="font-semibold text-link hover:underline"
                          data-row-link
                          data-preview={`/${locale}${href(after ? { after } : { page })}&open=${row.number}`}
                          data-open={openNumber === row.number ? '' : undefined}
                        >
                          {row.number}
                        </Link>
                      </td>
                      <td className={cn(cell, 'min-w-48')}>
                        <span className="break-words">{row.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`queues.statuses.${row.status}`)}
                          {row.line === 'l2' && ` · ${t('queues.lineL2')}`}
                          {row.snoozedUntil && ` · ${t('queues.snoozed', { time: format.dateTime(row.snoozedUntil, { dateStyle: 'short', timeStyle: 'short' }) })}`}
                        </span>
                        {/* Причина передачи помощником в строке очереди "После AI" (FR-AG-19). */}
                        {queue === 'after_ai' && row.aiHandoffReason && (
                          <span className="block text-xs text-secondary-foreground" data-ai-reason={row.aiHandoffReason}>
                            {t('queues.aiReason', { reason: t(`ticket.aiReasons.${row.aiHandoffReason}`) })}
                          </span>
                        )}
                        {row.tags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1" data-row-tags>
                            {row.tags.map((item) => (
                              <Link key={item.tagId} href={href({ queue: 'all', tag: item.tagId, page: 1 })} title={t('queues.byTag', { name: item.name })}>
                                <TagChip color={item.color}>{item.name}</TagChip>
                              </Link>
                            ))}
                          </span>
                        )}
                        {/* Вернулось из отложенных: пометка стоит до первого действия сотрудника (FR-AG-13). */}
                        {row.snoozeReturned && (
                          <span data-snooze-returned className="mt-1 block">
                            <StatusLabel tone="orange">{t('queues.snoozeReturned')}</StatusLabel>
                          </span>
                        )}
                      </td>
                      <td className={cell}>{row.orgName}</td>
                      <td className={cn(cell, 'font-semibold')}>{row.priority.toUpperCase()}</td>
                      <td className={cell}>
                        <SlaBadge phase={row.slaPhase} label={row.status === 'waiting_customer' ? t('queues.sla.paused') : slaText(row.minutesLeft)} />
                      </td>
                      <td className={cell}>{row.assigneeName ?? <span className="text-muted-foreground">{t('queues.unassigned')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            </>
          )}
          <div className="flex gap-2">
            {after ? (
              <Link href={href({ page: 1 })} className="text-sm text-link hover:underline">
                {t('queues.first')}
              </Link>
            ) : (
              page > 1 && (
                <Link href={href({ page: page - 1 })} className="text-sm text-link hover:underline">
                  {t('queues.prev')}
                </Link>
              )
            )}
            {list.hasMore && (
              <Link href={list.nextCursor ? href({ after: list.nextCursor }) : href({ page: page + 1 })} className="text-sm text-link hover:underline">
                {t('queues.next')}
              </Link>
            )}
          </div>

          <details className="rounded-control border border-border bg-card p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('queues.saveTitle')}</summary>
            <form action={saveFilterAction} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="queue" value={queue} />
              <input type="hidden" name="sort" value={sort} />
              <input type="hidden" name="q" value={q ?? ''} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label htmlFor="filter-name" className="text-sm font-medium">
                  {t('queues.filterName')}
                </label>
                <Input id="filter-name" name="name" required maxLength={80} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isShared" className="size-4 accent-primary" />
                {t('queues.shareFilter')}
              </label>
              <Button type="submit" variant="secondary">
                {t('queues.saveFilter')}
              </Button>
            </form>
          </details>
        </div>
        <QueuePreview number={openNumber} queue={queue} sort={sort} staff={staff} />
      </div>
      <QueueKeys />
    </>
  );
}
