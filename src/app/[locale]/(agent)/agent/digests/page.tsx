import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { REPORT_KINDS } from '@/modules/hda/api/constants';
import { listDigests } from '@/modules/hda/api/digests';
import { requireStaffActor } from '@/modules/hdu/api';
import { AgentMark } from '@/ui/components/AgentMark';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';

// Раздел "Сводки" (ТЗ 8.12 "Сводки", образец "Список"; FR-AGT-04, 07; план M8b, задача 10, решения 22, 23): сводки
// AI-сотрудника новые сверху с датой, видом, автором и пометкой "не проверено" или "просмотрено". Видят все
// сотрудники. Фильтр вида и пометки обычной формой GET; таблица прокручивается вбок внутри карточки.

const STATUSES = ['unverified', 'reviewed'] as const;

export default async function DigestsPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; after?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.digests');
  const format = await getFormatter();
  const search = await searchParams;
  const kindRaw = firstParam(search.kind) ?? '';
  const statusRaw = firstParam(search.status) ?? '';
  const kind = (REPORT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as (typeof REPORT_KINDS)[number]) : undefined;
  const status = (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as (typeof STATUSES)[number]) : undefined;
  const after = /^[0-9a-f-]{36}$/i.test(firstParam(search.after) ?? '') ? firstParam(search.after) : undefined;
  const { items, nextCursor } = await listDigests(staff, { ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(after ? { cursor: after } : {}) });
  const next = nextCursor ? `/agent/digests?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}), after: nextCursor }).toString()}` : null;
  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        <p className="text-secondary-foreground">{s('intro')}</p>
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="digests-kind">{s('filters.kind')}</Label>
            <Select id="digests-kind" name="kind" defaultValue={kind ?? ''}>
              <option value="">{s('filters.any')}</option>
              {REPORT_KINDS.map((value) => (
                <option key={value} value={value}>
                  {s(`kinds.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="digests-status">{s('filters.status')}</Label>
            <Select id="digests-status" name="status" defaultValue={status ?? ''}>
              <option value="">{s('filters.any')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {s(`statuses.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            {s('filters.apply')}
          </Button>
        </form>
        {items.length === 0 ? (
          <Card>
            <EmptyState title={s('empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('title')} data-testid="agent-digests">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['date', 'kind', 'title', 'author', 'mark'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b border-border align-top last:border-b-0" data-digest-row={row.id}>
                    <td className="whitespace-nowrap px-3 py-3">{format.dateTime(row.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td className="px-3 py-3">{s(`kinds.${row.kind}`)}</td>
                    <td className="break-words px-3 py-3">
                      <Link href={`/agent/digests/${row.id}`} className="text-link underline underline-offset-2">
                        {row.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{s('author')}</td>
                    <td className="px-3 py-3">{row.status === 'reviewed' ? <StatusLabel tone="green">{s('statuses.reviewed')}</StatusLabel> : <AgentMark label={t('aiStaff.mark')} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {next && (
          <Link href={next} className="self-start text-link underline underline-offset-2">
            {s('more')}
          </Link>
        )}
      </div>
    </>
  );
}
