import type { ReactNode } from 'react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import {
  type Breakdown,
  canReviewCsat,
  canSeeBreakdown,
  CSAT_REVIEW_MAX,
  getMetrics,
  getMetricsBreakdown,
  isHdtError,
  LOW_RATINGS_LIMIT,
  METRICS_PRESETS,
  METRICS_REPORTS,
  METRICS_ROW_CAP,
  type MetricsView,
  splitMinutes,
} from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { saveCsatReviewAction } from './actions';

// "Показатели" (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9, решения 14-16). Страницу видят все
// сотрудники; срез по организациям и модулям и выгрузку видят Customer Care, продукт, администратор и руководители
// линий. Период выбирается обычной формой GET и работает без скриптов. Числа считаются при каждом показе, кеша нет.
// Графиков нет: доли показаны числом и полосой <progress>.

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2 align-top';
const numeric = `${cell} tabular-nums`;
const ERRORS = new Set(['forbidden', 'invalid_input', 'not_found']);
const MAX_PAGES = 40;

const pagesOf = (value: string | undefined): number => {
  const pages = Number(value);
  return Number.isInteger(pages) && pages >= 1 && pages <= MAX_PAGES ? pages : 1;
};

function Stat({ id, label, value, children }: { id: string; label: string; value: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-card p-4" data-stat={id}>
      <dt className="text-sm text-secondary-foreground">{label}</dt>
      <dd className="text-2xl font-bold tabular-nums">{value}</dd>
      {children && <dd className="text-sm text-muted-foreground">{children}</dd>}
    </div>
  );
}

export default async function MetricsPage({ searchParams }: PageProps<'/[locale]/agent/metrics'>) {
  const staff = await requireStaffActor();
  const query = await searchParams;
  const input = { period: firstParam(query.period), from: firstParam(query.from), to: firstParam(query.to) };
  let view: MetricsView;
  let invalid = false;
  try {
    view = await getMetrics(staff, input);
  } catch (error) {
    if (!isHdtError(error) || error.code !== 'invalid_input') throw error;
    invalid = true;
    view = await getMetrics(staff, {});
  }
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const locale = await getLocale();
  const { period, overview } = view;
  const periodQuery = period.preset === 'custom' ? `period=custom&from=${period.fromDay}&to=${period.toDay}` : `period=${period.preset}`;
  const canBreakdown = canSeeBreakdown(staff);
  const canReview = canReviewCsat(staff);
  // Пусто, когда в периоде нет ни созданных, ни завершённых обращений: завершённые считаются и без созданных.
  const empty = overview.created === 0 && overview.finished === 0;
  const orgPages = pagesOf(firstParam(query.orgPages));
  const modulePages = pagesOf(firstParam(query.modulePages));
  const [orgs, modules] =
    canBreakdown && !empty
      ? await Promise.all([
          getMetricsBreakdown(staff, { period: period.preset, from: period.fromDay, to: period.toDay, by: 'org', pages: orgPages, locale }),
          getMetricsBreakdown(staff, { period: period.preset, from: period.fromDay, to: period.toDay, by: 'module', pages: modulePages, locale }),
        ])
      : [null, null];

  const none = t('metrics.none');
  const day = (instant: Date) => format.dateTime(instant, { dateStyle: 'medium', timeZone: view.timeZone });
  const number = (value: number | null, digits = 1) => (value === null ? none : format.number(value, { maximumFractionDigits: digits }));
  const share = (value: number | null) => (value === null ? none : `${format.number(value, { maximumFractionDigits: 1 })}%`);
  const duration = (minutes: number | null) => {
    if (minutes === null) return none;
    const parts = splitMinutes(minutes);
    return parts.hours > 0 ? t('metrics.duration', parts) : t('metrics.durationMinutes', { minutes: parts.minutes });
  };
  const bar = (value: number | null, label: string) => <progress value={value ?? 0} max={100} aria-label={label} className="h-2 w-24 shrink-0 accent-primary" />;
  const sourceName = (source: string) => (t.has(`metrics.sources.names.${source}`) ? t(`metrics.sources.names.${source}`) : source);
  const error = firstParam(query.error);

  const breakdownTable = (data: Breakdown, kind: 'org' | 'module', pages: number) => (
    <Card className="overflow-x-auto" data-breakdown={kind}>
      <CardHeader>
        <h2 className="text-base font-semibold">{t(kind === 'org' ? 'metrics.breakdown.orgsTitle' : 'metrics.breakdown.modulesTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('metrics.breakdown.hint')}</p>
      </CardHeader>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={head}>{t(kind === 'org' ? 'metrics.breakdown.org' : 'metrics.breakdown.module')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.created')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.resolved')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.firstResponse')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.resolution')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.csatCount')}</th>
            <th scope="col" className={head}>{t('metrics.breakdown.csatAverage')}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.key ?? 'none'} className="border-b border-border last:border-b-0">
              <th scope="row" className={`${cell} text-start font-medium wrap-anywhere`}>
                {kind === 'org' && item.key ? (
                  <Link href={`/agent/organizations/${item.key}`} className="text-link underline-offset-2 hover:underline">
                    {item.name ?? t('metrics.breakdown.unknown')}
                  </Link>
                ) : (
                  (item.name ?? t(item.key === null && kind === 'module' ? 'metrics.breakdown.noModule' : 'metrics.breakdown.unknown'))
                )}
              </th>
              <td className={numeric}>{format.number(item.created)}</td>
              <td className={numeric}>{format.number(item.resolved)}</td>
              <td className={numeric}>{share(item.firstResponsePercent)}</td>
              <td className={numeric}>{share(item.resolutionPercent)}</td>
              <td className={numeric}>{format.number(item.csatCount)}</td>
              <td className={numeric}>{number(item.csatAverage, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.hasMore && pages < MAX_PAGES && (
        <CardContent className="pt-4">
          <Link
            href={`/agent/metrics?${periodQuery}&orgPages=${kind === 'org' ? pages + 1 : orgPages}&modulePages=${kind === 'module' ? pages + 1 : modulePages}`}
            className={buttonVariants({ variant: 'secondary', size: 'small' })}
          >
            {t('metrics.breakdown.more')}
          </Link>
        </CardContent>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title={t('metrics.title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('metrics.title') }]} breadcrumbsLabel={t('breadcrumbs')} />

      {invalid && <Alert tone="danger">{t('metrics.period.invalid')}</Alert>}
      {firstParam(query.done) === 'reviewed' && <Alert tone="success">{t('metrics.done.reviewed')}</Alert>}
      {error && ERRORS.has(error) && <Alert tone="danger">{t(`metrics.errors.${error}`)}</Alert>}

      <form method="get" className="flex flex-wrap items-end gap-3" data-period-form>
        <div className="flex flex-col gap-1">
          <Label htmlFor="metrics-period">{t('metrics.period.label')}</Label>
          <Select id="metrics-period" name="period" defaultValue={period.preset} aria-describedby="metrics-period-hint">
            {METRICS_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t(`metrics.period.days${preset}`)}
              </option>
            ))}
            <option value="custom">{t('metrics.period.custom')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="metrics-from">{t('metrics.period.from')}</Label>
          <Input id="metrics-from" name="from" type="date" defaultValue={period.fromDay} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="metrics-to">{t('metrics.period.to')}</Label>
          <Input id="metrics-to" name="to" type="date" defaultValue={period.toDay} />
        </div>
        <Button type="submit">{t('metrics.period.show')}</Button>
        <p id="metrics-period-hint" className="basis-full text-sm text-muted-foreground">
          {t('metrics.period.hint')}
        </p>
      </form>

      <p className="text-sm text-secondary-foreground" data-period={`${period.fromDay}..${period.toDay}`}>
        {t('metrics.period.line', { from: day(period.from), to: day(new Date(period.to.getTime() - 1)), days: period.days, zone: view.timeZone })} {t('metrics.definition')}
      </p>

      {empty ? (
        <Card>
          <EmptyState title={t('metrics.empty.title')} text={t('metrics.empty.text')} />
        </Card>
      ) : (
        <>
          {view.capped && <Alert tone="info">{t('metrics.capped', { count: METRICS_ROW_CAP })}</Alert>}

          <section aria-labelledby="metrics-overview" className="flex flex-col gap-3">
            <h2 id="metrics-overview" className="text-base font-semibold">
              {t('metrics.overview.title')}
            </h2>
            <dl className="grid grid-cols-1 gap-3 tablet:grid-cols-2 lg:grid-cols-4">
              <Stat id="created" label={t('metrics.overview.created')} value={format.number(overview.created)} />
              <Stat id="resolved" label={t('metrics.overview.resolved')} value={format.number(overview.resolved)} />
              <Stat id="closed" label={t('metrics.overview.closed')} value={format.number(overview.closed)} />
              <Stat id="finished" label={t('metrics.overview.finished')} value={format.number(overview.finished)}>
                {t('metrics.overview.finishedHint')}
              </Stat>
              <Stat id="csat" label={t('metrics.overview.csatAverage')} value={number(overview.csat.average, 2)}>
                {t('metrics.overview.csatCount')}: {format.number(overview.csat.count)}. {t('metrics.overview.csatHigh')}: {share(overview.csat.highPercent)}
              </Stat>
              <Stat id="first-response-sla" label={t('metrics.overview.firstResponseSla')} value={share(overview.firstResponse.percent)}>
                {t('metrics.overview.slaOf', { ok: overview.firstResponse.ok, total: overview.firstResponse.total })}
              </Stat>
              <Stat id="resolution-sla" label={t('metrics.overview.resolutionSla')} value={share(overview.resolution.percent)}>
                {t('metrics.overview.slaOf', { ok: overview.resolution.ok, total: overview.resolution.total })}
              </Stat>
              <Stat id="first-response-time" label={t('metrics.overview.firstResponseTime')} value={duration(overview.firstResponseTime.averageMinutes)}>
                {t('metrics.overview.median')}: {duration(overview.firstResponseTime.medianMinutes)}, {t('metrics.overview.basedOn', { count: overview.firstResponseTime.count })}
              </Stat>
              <Stat id="resolution-time" label={t('metrics.overview.resolutionTime')} value={duration(overview.resolutionTime.averageMinutes)}>
                {t('metrics.overview.median')}: {duration(overview.resolutionTime.medianMinutes)}, {t('metrics.overview.basedOn', { count: overview.resolutionTime.count })}
              </Stat>
            </dl>
            <p className="text-sm text-muted-foreground">
              {t('metrics.overview.slaHint')} {t('metrics.overview.timeHint')}
            </p>
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="overflow-x-auto" data-block="sources">
              <CardHeader>
                <h2 className="text-base font-semibold">{t('metrics.sources.title')}</h2>
              </CardHeader>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={head}>{t('metrics.sources.source')}</th>
                    <th scope="col" className={head}>{t('metrics.sources.count')}</th>
                    <th scope="col" className={head}>{t('metrics.sources.share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.sources.map((row) => (
                    <tr key={row.source} className="border-b border-border last:border-b-0" data-source={row.source}>
                      <th scope="row" className={`${cell} text-start font-medium`}>{sourceName(row.source)}</th>
                      <td className={numeric}>{format.number(row.count)}</td>
                      <td className={numeric}>
                        <span className="flex items-center gap-2">
                          {bar(row.percent, t('metrics.sources.shareOf', { name: sourceName(row.source) }))}
                          {share(row.percent)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="overflow-x-auto" data-block="lines">
              <CardHeader>
                <h2 className="text-base font-semibold">{t('metrics.lines.title')}</h2>
              </CardHeader>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={head}>{t('metrics.lines.line')}</th>
                    <th scope="col" className={head}>{t('metrics.lines.resolved')}</th>
                    <th scope="col" className={head}>{t('metrics.lines.share')}</th>
                    <th scope="col" className={head}>{t('metrics.lines.averageTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.lines.rows.map((row) => (
                    <tr key={row.line} className="border-b border-border last:border-b-0" data-line={row.line}>
                      <th scope="row" className={`${cell} text-start font-medium`}>{t(`metrics.lines.names.${row.line}`)}</th>
                      <td className={numeric}>{format.number(row.resolved)}</td>
                      <td className={numeric}>
                        <span className="flex items-center gap-2">
                          {bar(row.percent, t('metrics.lines.shareOf', { name: t(`metrics.lines.names.${row.line}`) }))}
                          {share(row.percent)}
                        </span>
                      </td>
                      <td className={numeric}>{duration(row.averageMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <CardContent className="flex flex-col gap-2 pt-4">
                <p className="text-sm font-medium" data-returns={view.lines.returns}>
                  {t('metrics.lines.returns', { count: view.lines.returns })}
                </p>
                <p className="text-sm text-muted-foreground">{t('metrics.lines.hint')}</p>
              </CardContent>
            </Card>
          </div>

          {orgs && breakdownTable(orgs, 'org', orgPages)}
          {modules && breakdownTable(modules, 'module', modulePages)}

          {canBreakdown && (
            <Card data-block="export">
              <CardHeader>
                <h2 className="text-base font-semibold">{t('metrics.export.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('metrics.export.hint')}</p>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {METRICS_REPORTS.map((report) => (
                  // Обычная ссылка, а не Link: предзагрузка ссылки не должна запускать выгрузку.
                  <a key={report} href={`/${locale}/agent/metrics/export?report=${report}&${periodQuery}`} download className={buttonVariants({ variant: 'secondary', size: 'small' })} data-export={report}>
                    {t(`metrics.export.${report}`)}
                  </a>
                ))}
              </CardContent>
            </Card>
          )}

          <Card className="overflow-x-auto" id="low-ratings" data-block="low-ratings">
            <CardHeader>
              <h2 className="text-base font-semibold">{t('metrics.low.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('metrics.low.hint')}</p>
            </CardHeader>
            {view.lowRatings.items.length === 0 ? (
              <CardContent>
                <p className="text-sm text-secondary-foreground">{t('metrics.low.empty')}</p>
              </CardContent>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={head}>{t('metrics.low.number')}</th>
                    <th scope="col" className={head}>{t('metrics.low.score')}</th>
                    <th scope="col" className={head}>{t('metrics.low.reason')}</th>
                    <th scope="col" className={head}>{t('metrics.low.org')}</th>
                    <th scope="col" className={head}>{t('metrics.low.assignee')}</th>
                    <th scope="col" className={head}>{t('metrics.low.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.lowRatings.items.map((item) => (
                    <tr key={item.number} className="border-b border-border last:border-b-0" data-low={item.number}>
                      <th scope="row" className={`${cell} text-start font-medium whitespace-nowrap`}>
                        <Link href={`/agent/tickets/SUP-${item.number}`} className="text-link underline-offset-2 hover:underline">
                          SUP-{item.number}
                        </Link>
                      </th>
                      <td className={numeric}>{item.score}</td>
                      <td className={`${cell} wrap-anywhere`}>
                        {item.reason && t.has(`metrics.low.reasons.${item.reason}`) ? t(`metrics.low.reasons.${item.reason}`) : t('metrics.low.noReason')}
                        {item.comment && <span className="block text-secondary-foreground">{item.comment}</span>}
                      </td>
                      <td className={`${cell} wrap-anywhere`}>{item.orgName ?? t('metrics.breakdown.unknown')}</td>
                      <td className={cell}>{item.assigneeName ?? t('metrics.low.noAssignee')}</td>
                      <td className={`${cell} wrap-anywhere`}>
                        {item.reviewNote ? (
                          <>
                            <span className="block whitespace-pre-wrap" data-review-note>
                              {item.reviewNote}
                            </span>
                            {item.reviewedOn && (
                              <span className="block text-xs text-muted-foreground">
                                {t('metrics.low.noteBy', { name: item.reviewedByName ?? '', date: format.dateTime(item.reviewedOn, { dateStyle: 'medium', timeStyle: 'short', timeZone: view.timeZone }) })}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-secondary-foreground">{t('metrics.low.noNote')}</span>
                        )}
                        {canReview && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-sm text-link">{t(item.reviewNote ? 'metrics.low.edit' : 'metrics.low.write')}</summary>
                            <form action={saveCsatReviewAction} className="mt-2 flex flex-col gap-2">
                              <input type="hidden" name="number" value={item.number} />
                              <input type="hidden" name="back" value={periodQuery} />
                              <Label htmlFor={`review-${item.number}`}>{t('metrics.low.noteLabel', { number: item.number })}</Label>
                              <Textarea id={`review-${item.number}`} name="note" required maxLength={CSAT_REVIEW_MAX} defaultValue={item.reviewNote ?? ''} className="min-h-20" />
                              <Button type="submit" size="small" className="self-start">
                                {t('metrics.low.save')}
                              </Button>
                            </form>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view.lowRatings.capped && (
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground">{t('metrics.low.capped', { count: LOW_RATINGS_LIMIT })}</p>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </>
  );
}
