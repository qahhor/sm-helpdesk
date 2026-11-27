import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { codeKnowledgeMetrics, listCodeEntries } from '@/modules/hda/api/code-knowledge';
import { CODE_ENTRY_STATUSES, CODE_READER_ROLES } from '@/modules/hda/api/constants';
import { requireStaffActor } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { CodeTabs } from './CodeTabs';
import { CODE_STATUS_TONE } from './status-tone';

// Очередь "Знания из кода" (ТЗ 8.12, FR-CODE-03, FR-CODE-15, FR-ADM-15; план M8c, задача 4, решения 23, 24): записи
// каталога ошибок черновиками, новые и изменённые с прошлого сканирования выделены; показатель пользы за 30 дней.
// Видят agent_l2, care, admin. Отбор статуса обычной формой GET.

const METRIC_DAYS = 30;
const FILTERS = [...CODE_ENTRY_STATUSES, 'all'] as const;

export default async function CodeKnowledgePage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const staff = await requireStaffActor({ roles: [...CODE_READER_ROLES] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.codeKnowledge');
  const search = await searchParams;
  const statusRaw = firstParam(search.status) ?? 'draft';
  const status = (FILTERS as readonly string[]).includes(statusRaw) ? (statusRaw as (typeof FILTERS)[number]) : 'draft';
  const page = Math.min(1000, Math.max(0, Number.parseInt(firstParam(search.page) ?? '0', 10) || 0));
  const [list, metrics] = await Promise.all([listCodeEntries(staff, { status, page }), codeKnowledgeMetrics(staff, { days: METRIC_DAYS })]);
  const next = list.hasMore ? `/agent/code-knowledge?${new URLSearchParams({ status, page: String(page + 1) }).toString()}` : null;
  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        <p className="text-secondary-foreground">{s('intro')}</p>
        <CodeTabs current="queue" />
        <Card>
          <CardContent className="flex flex-col gap-1 pt-6 text-sm" data-code-metrics>
            <h2 className="font-semibold">{s('metrics.title', { days: metrics.days })}</h2>
            <p>{s('metrics.share', { matched: metrics.fromTemplate, total: metrics.withSignature })}</p>
            <p>{s('metrics.solutions', { count: metrics.solutionsFromEntries })}</p>
            <p className="text-secondary-foreground">{s('drafts', { count: list.drafts })}</p>
          </CardContent>
        </Card>
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="code-status">{s('filters.status')}</Label>
            <Select id="code-status" name="status" defaultValue={status}>
              {FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value === 'all' ? s('filters.all') : s(`statuses.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            {s('filters.apply')}
          </Button>
        </form>
        {list.items.length === 0 ? (
          <Card>
            <EmptyState title={s('empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('tabs.queue')} data-testid="code-entries">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['key', 'code', 'module', 'kind', 'confidence', 'status'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={row.key} className="border-b border-border align-top last:border-b-0" data-code-entry={row.key}>
                    <td className="break-all px-3 py-3">
                      <Link href={`/agent/code-knowledge/${encodeURIComponent(row.key)}`} className="text-link underline underline-offset-2">
                        {row.key}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">{row.code ?? ''}</td>
                    <td className="px-3 py-3">{row.moduleCode ?? ''}</td>
                    <td className="px-3 py-3">{s(`kinds.${row.kind}`)}</td>
                    <td className="px-3 py-3">{Math.round(row.confidence * 100)}%</td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1">
                        <StatusLabel tone={CODE_STATUS_TONE[row.status]}>{s(`statuses.${row.status}`)}</StatusLabel>
                        {row.highlighted && <StatusLabel tone="orange">{s(`changes.${row.changeKind === 'changed' ? 'changed' : 'new'}`)}</StatusLabel>}
                      </span>
                    </td>
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
