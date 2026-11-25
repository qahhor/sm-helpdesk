import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isLocale, LOCALES, type Locale } from '@/i18n/locales';
import { canWriteSolutions, listSolutions, type SolutionListRow } from '@/modules/hdk/api/editor';
import { SOLUTION_LIST_STATUSES, type SolutionListStatus } from '@/modules/hdk/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';

// Решения (план M5, задача 3; UX-W-10): "Мои задачи" (мои черновики и мои решения на пересмотре) и список всех
// решений с фильтрами по статусу, модулю, языку и "На пересмотр" (FR-SOL-19, решение 18); у каждого решения показы и
// исходы (задача 11). Читают все сотрудники, новое решение создают роли черновиков.

const TONE: Record<SolutionListStatus, StatusTone> = {
  draft: 'gray',
  published: 'green',
  archived: 'orange',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SolutionsPage({ searchParams }: { searchParams: Promise<{ status?: string; module?: string; lang?: string; review?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.solutions');
  const locale = await getLocale();
  const format = await getFormatter();
  const query = await searchParams;
  const status = (SOLUTION_LIST_STATUSES as readonly string[]).includes(query.status ?? '') ? (query.status as SolutionListStatus) : undefined;
  const moduleId = query.module && UUID.test(query.module) ? query.module : undefined;
  const lang: Locale | undefined = query.lang && isLocale(query.lang) ? query.lang : undefined;
  const review = query.review === '1';
  const [mine, all, modules] = await Promise.all([
    listSolutions(staff, { mine: true }),
    listSolutions(staff, {
      ...(status ? { status } : {}),
      ...(moduleId ? { moduleId } : {}),
      ...(lang ? { locale: lang } : {}),
      ...(review ? { review: true } : {}),
    }),
    listActiveModules(staff.actor, locale),
  ]);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const canWrite = canWriteSolutions(staff);

  const table = (rows: SolutionListRow[], label: string, testId: string) => (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={label} data-testid={testId}>
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {(['number', 'title', 'module', 'language', 'status', 'shown', 'helped', 'notHelped', 'updated'] as const).map((column) => (
              <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                {s(`columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.articleId} data-solution={row.number} className="border-b border-border align-top last:border-b-0">
              <td className="px-3 py-3 tabular-nums">{row.number}</td>
              <th scope="row" className="px-3 py-3 text-start font-normal">
                <Link href={`/agent/solutions/${row.number}`} className="break-words font-semibold text-link underline-offset-2 hover:underline">
                  {row.title || s('untitled')}
                </Link>
              </th>
              <td className="px-3 py-3">{row.moduleId ? (moduleName.get(row.moduleId) ?? s('moduleInactive')) : s('noModule')}</td>
              <td className="px-3 py-3">{s(`locales.${row.originalLocale}`)}</td>
              <td className="px-3 py-3">
                <span className="flex flex-wrap gap-1">
                  <StatusLabel tone={TONE[row.status]}>{s(`statuses.${row.status}`)}</StatusLabel>
                  {row.status === 'published' && row.hasDraft && <StatusLabel tone="blue">{s('hasChanges')}</StatusLabel>}
                  {row.audience === 'internal' && <StatusLabel tone="purple">{s('internalOnly')}</StatusLabel>}
                  {row.needsReview && <StatusLabel tone="danger">{s('needsReview')}</StatusLabel>}
                </span>
              </td>
              <td className="px-3 py-3 tabular-nums" data-column="shown">{format.number(row.shownCount)}</td>
              <td className="px-3 py-3 tabular-nums" data-column="helped">{format.number(row.helpedCount)}</td>
              <td className="px-3 py-3 tabular-nums" data-column="not-helped">{format.number(row.notHelpedCount)}</td>
              <td className="px-3 py-3 whitespace-nowrap">
                {format.dateTime(row.updatedOn, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );

  return (
    <>
      <PageHeader
        title={s('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          canWrite ? (
            <Link href="/agent/solutions/new" className={buttonVariants()}>
              {s('new')}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-6">
        <section aria-labelledby="solutions-mine" className="flex flex-col gap-3">
          <h2 id="solutions-mine" className="text-lg font-semibold">
            {s('mine.title')}
          </h2>
          <p className="text-sm text-secondary-foreground">{s('mine.intro')}</p>
          {mine.length === 0 ? (
            <Card>
              <EmptyState title={s('mine.emptyTitle')} text={s('mine.emptyText')} />
            </Card>
          ) : (
            table(mine, s('mine.title'), 'solutions-mine')
          )}
        </section>

        <section aria-labelledby="solutions-all" className="flex flex-col gap-3">
          <h2 id="solutions-all" className="text-lg font-semibold">
            {s('all.title')}
          </h2>
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
            <div className="flex flex-col gap-1">
              <Label htmlFor="filter-status">{s('filters.status')}</Label>
              <Select id="filter-status" name="status" defaultValue={status ?? ''}>
                <option value="">{s('filters.any')}</option>
                {SOLUTION_LIST_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {s(`statuses.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="filter-module">{s('filters.module')}</Label>
              <Select id="filter-module" name="module" defaultValue={moduleId ?? ''}>
                <option value="">{s('filters.any')}</option>
                {modules.map((m) => (
                  <option key={m.moduleId} value={m.moduleId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="filter-lang">{s('filters.language')}</Label>
              <Select id="filter-lang" name="lang" defaultValue={lang ?? ''}>
                <option value="">{s('filters.any')}</option>
                {LOCALES.map((value) => (
                  <option key={value} value={value}>
                    {s(`locales.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 self-center text-sm">
              <input type="checkbox" name="review" value="1" defaultChecked={review} className="size-4 accent-primary" />
              {s('filters.review')}
            </label>
            <Button type="submit" variant="secondary">
              {s('filters.apply')}
            </Button>
          </form>
          <p className="text-sm text-secondary-foreground">{s('all.countsHint')}</p>
          {all.length === 0 ? (
            <Card>
              <EmptyState title={s('all.emptyTitle')} text={s('all.emptyText')} />
            </Card>
          ) : (
            table(all, s('all.title'), 'solutions-all')
          )}
        </section>
      </div>
    </>
  );
}
