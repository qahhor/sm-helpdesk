import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { canSeePilot, isHdtError, METRICS_PRESETS, type PilotRow, type PilotSummary, pilotSummary } from '@/modules/hdt/api';
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

// Вкладка "Пилот" страницы показателей (план M9, задача 3, решение 13; ТЗ 16.7): восемь строк таблицы 16.7 и доля
// пришедших мимо портала в Telegram по организациям настройки pilot.org_ids. Видят Customer Care и администратор,
// остальным страница отвечает 404. Только числа; период выбирается той же формой GET, что на странице показателей.

const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3 py-2 align-top';

export default async function PilotMetricsPage({ searchParams }: PageProps<'/[locale]/agent/metrics/pilot'>) {
  const staff = await requireStaffActor();
  if (!canSeePilot(staff)) notFound();
  const query = await searchParams;
  const input = { period: firstParam(query.period), from: firstParam(query.from), to: firstParam(query.to) };
  let summary: PilotSummary;
  let invalid = false;
  try {
    summary = await pilotSummary(staff, input);
  } catch (error) {
    if (!isHdtError(error) || error.code !== 'invalid_input') throw error;
    invalid = true;
    summary = await pilotSummary(staff, {});
  }
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const locale = await getLocale();
  const { period } = summary;
  const periodQuery = period.preset === 'custom' ? `period=custom&from=${period.fromDay}&to=${period.toDay}` : `period=${period.preset}`;
  const day = (instant: Date) => format.dateTime(instant, { dateStyle: 'medium', timeZone: summary.timeZone });
  const amount = (value: number) => format.number(value, { maximumFractionDigits: 2 });
  const shown = (row: PilotRow, value: number | null) => {
    if (value === null) return t('metrics.none');
    return row.key === 'ai_cost' ? t('metrics.pilot.usd', { value: amount(value) }) : `${format.number(value, { maximumFractionDigits: 1 })}%`;
  };
  const target = (row: PilotRow) => {
    if (row.key === 'leaks') return t('metrics.pilot.leaksTarget');
    if (row.target === null || row.direction === null) return t('metrics.none');
    return t(row.direction === 'min' ? 'metrics.pilot.min' : 'metrics.pilot.max', { value: shown(row, row.target) });
  };
  const result = (row: PilotRow) => (row.met === null ? t('metrics.pilot.noData') : t(row.met ? 'metrics.pilot.met' : 'metrics.pilot.missed'));

  return (
    <>
      <PageHeader
        title={t('metrics.pilot.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('metrics.title'), href: '/agent/metrics' }, { label: t('metrics.pilot.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <MetricsTabs current="pilot" query={periodQuery} label={t('metrics.tabs.label')} allLabel={t('metrics.tabs.all')} pilotLabel={t('metrics.tabs.pilot')} showPilot />
      {invalid && <Alert tone="danger">{t('metrics.period.invalid')}</Alert>}
      <p className="text-sm text-secondary-foreground">{t('metrics.pilot.intro')}</p>

      <form method="get" className="flex flex-wrap items-end gap-3" data-period-form>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pilot-period">{t('metrics.period.label')}</Label>
          <Select id="pilot-period" name="period" defaultValue={period.preset}>
            {METRICS_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t(`metrics.period.days${preset}`)}
              </option>
            ))}
            <option value="custom">{t('metrics.period.custom')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pilot-from">{t('metrics.period.from')}</Label>
          <Input id="pilot-from" name="from" type="date" defaultValue={period.fromDay} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pilot-to">{t('metrics.period.to')}</Label>
          <Input id="pilot-to" name="to" type="date" defaultValue={period.toDay} />
        </div>
        <Button type="submit">{t('metrics.period.show')}</Button>
      </form>

      <p className="text-sm text-secondary-foreground" data-period={`${period.fromDay}..${period.toDay}`}>
        {t('metrics.period.line', { from: day(period.from), to: day(new Date(period.to.getTime() - 1)), days: period.days, zone: summary.timeZone })}
      </p>

      {summary.orgCount === 0 ? (
        <Card>
          <EmptyState title={t('metrics.pilot.emptyTitle')} text={t('metrics.pilot.emptyText')} />
        </Card>
      ) : (
        <Card className="overflow-x-auto" data-pilot-summary>
          <CardHeader>
            <p className="text-sm text-secondary-foreground wrap-anywhere">
              {t('metrics.pilot.orgs', { names: summary.orgs.map((org) => org.name).join(', ') })}
            </p>
          </CardHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={head}>{t('metrics.pilot.metric')}</th>
                <th scope="col" className={head}>{t('metrics.pilot.value')}</th>
                <th scope="col" className={head}>{t('metrics.pilot.target')}</th>
                <th scope="col" className={head}>{t('metrics.pilot.result')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.key} className="border-b border-border last:border-b-0" data-pilot-row={row.key}>
                  <th scope="row" className={`${cell} text-start font-medium`}>
                    {t(`metrics.pilot.metrics.${row.key}`)}
                    {row.key === 'ai_resolved' && <span className="block text-xs font-normal text-muted-foreground">{t('metrics.pilot.aiReview')}</span>}
                    {row.key === 'ai_cost' && <span className="block text-xs font-normal text-muted-foreground">{t('metrics.pilot.costHint')}</span>}
                  </th>
                  <td className={`${cell} tabular-nums`}>
                    {row.key === 'leaks' ? t('metrics.pilot.leaksValue') : shown(row, row.value)}
                    {row.base !== null && row.value !== null && <span className="block text-xs text-muted-foreground">{t('metrics.pilot.base', { count: row.base })}</span>}
                  </td>
                  <td className={`${cell} tabular-nums`}>{target(row)}</td>
                  <td className={cell}>{result(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <CardContent className="pt-4">
            {/* Обычная ссылка, а не Link: предзагрузка ссылки не должна запускать выгрузку. */}
            <a href={`/${locale}/agent/metrics/export?report=pilot&${periodQuery}`} download className={buttonVariants({ variant: 'secondary', size: 'small' })} data-export="pilot">
              {t('metrics.pilot.export')}
            </a>
          </CardContent>
        </Card>
      )}
    </>
  );
}
