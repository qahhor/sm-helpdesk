import type { ReactNode } from 'react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import {
  type Breakdown,
  canReviewCsat,
  canSeeBreakdown,
  canSeePilot,
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
import { assistantRunStats } from '@/modules/hda/api/metrics';
import { getAssistantMetrics } from '@/modules/hdt/api/metrics';
import { getKnowledgeMetrics, type KnowledgeMetrics } from '@/modules/hdk/api/metrics';
import { type CandidateMetrics, candidateMetrics, canSeeCandidateMetrics } from '@/modules/hda/api/candidate-metrics';
import { type ProblemMetrics, problemMetrics } from '@/modules/hdp/api/metrics';
import { canSeeSuggestMisses, type MissSummary, suggestMisses } from '@/modules/hdk/api/misses';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { MetricsTabs } from '@/ui/components/MetricsTabs';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { saveCsatReviewAction } from './actions';

// "Показатели" (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9, решения 14-16). Страницу видят все
// сотрудники; срез по организациям и модулям и выгрузку видят Customer Care, продукт, администратор и руководители
// линий. Период выбирается обычной формой GET и работает без скриптов. Числа считаются при каждом показе, кеша нет.
// Графиков нет: доли показаны числом и полосой <progress>. Блоки знаний (FR-MET-02, 05; план M5, задача 11) считает
// модуль hdk за тот же период: подсказка решений и частые ошибки без решения.

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
  const input = { period: firstParam(query.period), from: firstParam(query.from), to: firstParam(query.to), noProblems: firstParam(query.noProblems) };
  let view: MetricsView;
  let invalid = false;
  try {
    view = await getMetrics(staff, input);
  } catch (error) {
    if (!isHdtError(error) || error.code !== 'invalid_input') throw error;
    invalid = true;
    view = await getMetrics(staff, {});
  }
  const knowledge: KnowledgeMetrics = await getKnowledgeMetrics(staff, { from: view.period.from, to: view.period.to });
  // Известные проблемы и кандидаты в решения (план M5c, задача 11; FR-MET-08, 09, FR-CAND-08).
  const problemsBlock: ProblemMetrics = await problemMetrics(staff, { from: view.period.from, to: view.period.to });
  const candidatesBlock: CandidateMetrics | null = canSeeCandidateMetrics(staff) ? await candidateMetrics(staff, { from: view.period.from, to: view.period.to }) : null;
  // Показатели AI-помощника (план M5b, задача 10; FR-MET-06, FR-AI-18): по обращениям периода и журналу вызовов.
  const [assistant, runs] = await Promise.all([getAssistantMetrics(staff, invalid ? {} : input), assistantRunStats(staff, { from: view.period.from, to: view.period.to })]);
  // Что клиенты ищут и не находят (план W6, решение 17): администратор и роли публикации решений.
  const misses: MissSummary | null = canSeeSuggestMisses(staff) ? await suggestMisses(staff) : null;
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const locale = await getLocale();
  const { period, overview } = view;
  const periodQuery = period.preset === 'custom' ? `period=custom&from=${period.fromDay}&to=${period.toDay}` : `period=${period.preset}`;
  const canBreakdown = canSeeBreakdown(staff);
  const canReview = canReviewCsat(staff);
  const moduleNames = misses ? new Map((await listActiveModules(staff.actor, locale)).map((m) => [m.moduleId, m.name])) : new Map<string, string>();
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
      <MetricsTabs current="all" query={periodQuery} label={t('metrics.tabs.label')} allLabel={t('metrics.tabs.all')} pilotLabel={t('metrics.tabs.pilot')} showPilot={canSeePilot(staff)} />

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
        <label className="inline-flex min-h-control items-center gap-2">
          <input type="checkbox" name="noProblems" value="on" defaultChecked={view.withoutProblems} className="size-5 accent-primary" />
          {t('metrics.noProblems')}
        </label>
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

          {/* Каналы (FR-MET-10; план M6, задача 8): портал, виджет (Web и приложение вместе), почта, сотрудник. */}
          <Card className="overflow-x-auto" data-block="channels">
            <CardHeader>
              <h2 className="text-base font-semibold">{t('metrics.channels.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('metrics.channels.hint')}</p>
            </CardHeader>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{t('metrics.channels.channel')}</th>
                  <th scope="col" className={head}>{t('metrics.breakdown.created')}</th>
                  <th scope="col" className={head}>{t('metrics.sources.share')}</th>
                  <th scope="col" className={head}>{t('metrics.breakdown.resolved')}</th>
                  <th scope="col" className={head}>{t('metrics.breakdown.firstResponse')}</th>
                  <th scope="col" className={head}>{t('metrics.breakdown.resolution')}</th>
                  <th scope="col" className={head}>{t('metrics.breakdown.csatAverage')}</th>
                </tr>
              </thead>
              <tbody>
                {view.channels.map((row) => (
                  <tr key={row.channel} className="border-b border-border last:border-b-0" data-channel={row.channel}>
                    <th scope="row" className={`${cell} text-start font-medium`}>{t(`metrics.channels.names.${row.channel}`)}</th>
                    <td className={numeric}>{format.number(row.count)}</td>
                    <td className={numeric}>
                      <span className="flex items-center gap-2">
                        {bar(row.percent, t('metrics.sources.shareOf', { name: t(`metrics.channels.names.${row.channel}`) }))}
                        {share(row.percent)}
                      </span>
                    </td>
                    <td className={numeric}>{format.number(row.resolved)}</td>
                    <td className={numeric}>{share(row.firstResponsePercent)}</td>
                    <td className={numeric}>{share(row.resolutionPercent)}</td>
                    <td className={numeric}>{number(row.csatAverage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {orgs && breakdownTable(orgs, 'org', orgPages)}
          {modules && breakdownTable(modules, 'module', modulePages)}

          {canBreakdown && (
            <Card data-block="export">
              <CardHeader>
                <h2 className="text-base font-semibold">{t('metrics.export.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('metrics.export.hint')}</p>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {METRICS_REPORTS.filter((report) => report !== 'pilot').map((report) => (
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

      {/* Известные проблемы и кандидаты (FR-MET-08, 09): активные проблемы на сейчас, остальное по периоду. */}
      <section aria-labelledby="metrics-problems" className="flex flex-col gap-3" data-block="problems">
        <h2 id="metrics-problems" className="text-base font-semibold">
          {t('metrics.problems.title')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-sm text-secondary-foreground">{t('metrics.problems.active')}</span>
              <span className="text-2xl font-semibold tabular-nums">{problemsBlock.activeCount}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-sm text-secondary-foreground">{t('metrics.problems.fixed')}</span>
              <span className="text-2xl font-semibold tabular-nums">{problemsBlock.fixedCount}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-sm text-secondary-foreground">{t('metrics.problems.toFix')}</span>
              <span className="text-2xl font-semibold tabular-nums">{problemsBlock.averageHoursToFix === null ? none : t('metrics.hours', { hours: number(problemsBlock.averageHoursToFix) })}</span>
            </CardContent>
          </Card>
        </div>
        {problemsBlock.active.length > 0 && (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{t('metrics.problems.problem')}</th>
                  <th scope="col" className={head}>{t('metrics.problems.tickets')}</th>
                  <th scope="col" className={head}>{t('metrics.problems.orgs')}</th>
                </tr>
              </thead>
              <tbody>
                {problemsBlock.active.map((row) => (
                  <tr key={row.number} className="border-b border-border last:border-b-0">
                    <th scope="row" className={`${cell} text-start font-medium wrap-anywhere`}>
                      <Link href={`/agent/problems/${row.number}`} className="text-link underline-offset-2 hover:underline">
                        KP-{row.number} {row.internalTitle}
                      </Link>
                    </th>
                    <td className={`${cell} tabular-nums`}>{row.ticketCount}</td>
                    <td className={`${cell} tabular-nums`}>{row.orgCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {candidatesBlock && (
        <section aria-labelledby="metrics-candidates" className="flex flex-col gap-3" data-block="candidates">
          <h2 id="metrics-candidates" className="text-base font-semibold">
            {t('metrics.candidates.title')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-5">
            {(['created', 'accepted', 'merged', 'rejected'] as const).map((key) => (
              <Card key={key}>
                <CardContent className="flex flex-col gap-1 pt-6">
                  <span className="text-sm text-secondary-foreground">{t(`metrics.candidates.${key}`)}</span>
                  <span className="text-2xl font-semibold tabular-nums">{candidatesBlock[key]}</span>
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardContent className="flex flex-col gap-1 pt-6">
                <span className="text-sm text-secondary-foreground">{t('metrics.candidates.toPublish')}</span>
                <span className="text-2xl font-semibold tabular-nums">{candidatesBlock.averageHoursToPublish === null ? none : t('metrics.hours', { hours: number(candidatesBlock.averageHoursToPublish) })}</span>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {/* Пустой период: показателей помощника тоже нет, как и остальных чисел периода. */}
      {!empty && (
        <section aria-labelledby="metrics-assistant" className="flex flex-col gap-3" data-block="assistant">
          <h2 id="metrics-assistant" className="text-base font-semibold">
            {t('metrics.assistant.title')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat id="ai-resolved" label={t('metrics.assistant.resolved')} value={share(assistant.resolvedByAiPercent)}>
              {t('metrics.assistant.resolvedOf', { resolved: assistant.resolvedByAi, handled: assistant.handled })}
            </Stat>
            <Stat
              id="ai-first-reply"
              label={t('metrics.assistant.firstReply')}
              value={assistant.firstReply.averageSeconds === null ? none : t('metrics.assistant.seconds', { value: Math.round(assistant.firstReply.averageSeconds) })}
            >
              {assistant.firstReply.medianSeconds !== null && t('metrics.assistant.median', { value: Math.round(assistant.firstReply.medianSeconds) })}
            </Stat>
            <Stat id="ai-csat" label={t('metrics.assistant.csat')} value={number(assistant.csat.average)}>
              {t('metrics.assistant.csatCount', { count: assistant.csat.count })}
            </Stat>
            <Stat id="ai-reopened" label={t('metrics.assistant.reopened')} value={format.number(assistant.reopenedAfterHelped)} />
            <Stat id="ai-flagged" label={t('metrics.assistant.flagged')} value={share(runs.flaggedPercent)}>
              {t('metrics.assistant.flaggedOf', { flagged: runs.flagged, answers: runs.answers })}
            </Stat>
            <Stat id="ai-spend" label={t('metrics.assistant.spend')} value={format.number(runs.spentMonthUsd, { style: 'currency', currency: 'USD' })} />
          </dl>
          <Card className="overflow-x-auto" data-block="handoffs">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('metrics.assistant.handoffs')}</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{t('metrics.assistant.handoffs')}</th>
                  <th scope="col" className={head}>{t('metrics.assistant.count')}</th>
                </tr>
              </thead>
              <tbody>
                {assistant.handoffs.length === 0 ? (
                  <tr>
                    <td className={cell} colSpan={2}>
                      {none}
                    </td>
                  </tr>
                ) : (
                  assistant.handoffs.map((row) => (
                    <tr key={row.reason} className="border-b border-border last:border-b-0" data-handoff={row.reason}>
                      <th scope="row" className={`${cell} text-start font-medium`}>
                        {t.has(`ticket.aiReasons.${row.reason}`) ? t(`ticket.aiReasons.${row.reason}`) : row.reason}
                      </th>
                      <td className={numeric}>{format.number(row.count)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>
          <p className="text-sm text-muted-foreground">{t('metrics.assistant.hint')}</p>
        </section>
      )}

      <section aria-labelledby="metrics-deflection" className="flex flex-col gap-3" data-block="deflection">
        <h2 id="metrics-deflection" className="text-base font-semibold">
          {t('metrics.knowledge.title')}
        </h2>
        {knowledge.deflection.shown === 0 ? (
          <p className="text-sm text-secondary-foreground" data-deflection-empty>
            {t('metrics.knowledge.empty')}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-3 tablet:grid-cols-2 lg:grid-cols-4">
            <Stat id="deflection-self" label={t('metrics.knowledge.selfService')} value={share(knowledge.deflection.selfServicePercent)}>
              {t('metrics.knowledge.selfServiceHint', { helped: knowledge.deflection.helped, shown: knowledge.deflection.shown })}
            </Stat>
            <Stat id="deflection-shown" label={t('metrics.knowledge.shown')} value={format.number(knowledge.deflection.shown)} />
            <Stat id="deflection-helped" label={t('metrics.knowledge.helped')} value={format.number(knowledge.deflection.helped)} />
            <Stat id="deflection-not-helped" label={t('metrics.knowledge.notHelped')} value={format.number(knowledge.deflection.notHelped)} />
            <Stat id="deflection-tickets" label={t('metrics.knowledge.tickets')} value={format.number(knowledge.deflection.ticketCreated)}>
              {share(knowledge.deflection.ticketPercent)}
            </Stat>
            <Stat id="deflection-left" label={t('metrics.knowledge.left')} value={format.number(knowledge.deflection.left)} />
          </dl>
        )}
        <p className="text-sm text-muted-foreground">{t('metrics.knowledge.hint')}</p>
        {knowledge.byOrg && knowledge.byOrg.length > 0 && (
          <Card className="overflow-x-auto" data-breakdown="deflection-org">
            <CardHeader>
              <h3 className="text-base font-semibold">{t('metrics.knowledge.byOrgTitle')}</h3>
            </CardHeader>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={head}>{t('metrics.breakdown.org')}</th>
                  <th scope="col" className={head}>{t('metrics.knowledge.shown')}</th>
                  <th scope="col" className={head}>{t('metrics.knowledge.helped')}</th>
                  <th scope="col" className={head}>{t('metrics.knowledge.notHelped')}</th>
                  <th scope="col" className={head}>{t('metrics.knowledge.tickets')}</th>
                  <th scope="col" className={head}>{t('metrics.knowledge.selfService')}</th>
                </tr>
              </thead>
              <tbody>
                {knowledge.byOrg.map((row) => (
                  <tr key={row.orgId} className="border-b border-border last:border-b-0">
                    <th scope="row" className={`${cell} text-start font-medium wrap-anywhere`}>
                      <Link href={`/agent/organizations/${row.orgId}`} className="text-link underline-offset-2 hover:underline">
                        {row.name ?? t('metrics.breakdown.unknown')}
                      </Link>
                    </th>
                    <td className={numeric}>{format.number(row.shown)}</td>
                    <td className={numeric}>{format.number(row.helped)}</td>
                    <td className={numeric}>{format.number(row.notHelped)}</td>
                    <td className={numeric}>{format.number(row.ticketCreated)}</td>
                    <td className={numeric}>{share(row.selfServicePercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <Card className="overflow-x-auto" data-block="unsolved">
        <CardHeader>
          <h2 className="text-base font-semibold">{t('metrics.knowledge.unsolvedTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('metrics.knowledge.unsolvedHint')}</p>
        </CardHeader>
        {knowledge.unsolved.length === 0 ? (
          <CardContent>
            <p className="text-sm text-secondary-foreground">{t('metrics.knowledge.unsolvedEmpty')}</p>
          </CardContent>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={head}>{t('metrics.knowledge.code')}</th>
                <th scope="col" className={head}>{t('metrics.knowledge.sample')}</th>
                <th scope="col" className={head}>{t('metrics.knowledge.orgs')}</th>
                <th scope="col" className={head}>{t('metrics.knowledge.times')}</th>
                {knowledge.canCreate && <th scope="col" className={head} />}
              </tr>
            </thead>
            <tbody>
              {knowledge.unsolved.map((row) => (
                <tr key={row.signatureId} className="border-b border-border last:border-b-0" data-unsolved={row.signatureId}>
                  <td className={`${cell} font-mono whitespace-nowrap`}>{row.sampleCode ?? t('metrics.knowledge.noCode')}</td>
                  <td className={`${cell} wrap-anywhere`}>{row.sampleMessage ?? t('metrics.knowledge.noSample')}</td>
                  <td className={numeric}>{format.number(row.orgCount)}</td>
                  <td className={numeric}>{format.number(row.occurrences)}</td>
                  {knowledge.canCreate && (
                    <td className={cell}>
                      <Link href={`/agent/solutions/new?signature=${row.signatureId}`} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
                        {t('metrics.knowledge.create')}
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {misses && (
        <Card className="overflow-x-auto" data-block="suggest-misses">
          <CardHeader>
            <h2 className="text-base font-semibold">{t('metrics.knowledge.missesTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('metrics.knowledge.missesHint')}</p>
          </CardHeader>
          {misses.recent.length === 0 ? (
            <CardContent>
              <p className="text-sm text-secondary-foreground">{t('metrics.knowledge.missesEmpty')}</p>
            </CardContent>
          ) : (
            <>
              <table className="w-full text-sm">
                <caption className="sr-only">{t('metrics.knowledge.missesWeek')}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={head}>{t('metrics.knowledge.missesModule')}</th>
                    <th scope="col" className={head}>{t('metrics.knowledge.missesLocale')}</th>
                    <th scope="col" className={head}>{t('metrics.knowledge.missesCount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {misses.byModule.map((row) => (
                    <tr key={`${row.moduleId ?? 'none'}-${row.locale}`} className="border-b border-border last:border-b-0">
                      <th scope="row" className={`${cell} text-start font-medium`}>
                        {row.moduleId ? (moduleNames.get(row.moduleId) ?? t('metrics.breakdown.unknown')) : t('metrics.knowledge.missesNoModule')}
                      </th>
                      <td className={cell}>{row.locale}</td>
                      <td className={numeric}>{format.number(row.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <CardContent className="pt-4">
                <h3 className="text-sm font-semibold">{t('metrics.knowledge.missesRecent')}</h3>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {misses.recent.map((row, index) => (
                    <li key={index} className="wrap-anywhere">
                      <span className="text-muted-foreground">{format.dateTime(row.on, { dateStyle: 'short' })} {row.locale}:</span> {row.text}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </>
          )}
        </Card>
      )}
    </>
  );
}
