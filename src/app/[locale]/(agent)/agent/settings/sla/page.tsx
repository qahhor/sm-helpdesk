import { getLocale, getTranslations } from 'next-intl/server';
import { loadSlaConfig, type Priority } from '@/modules/hdr/api';
import { readPickup } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { Textarea } from '@/ui/components/textarea';
import { settingsNav } from '../sections';
import { saveCalendarAction, saveHolidaysAction, savePickupAction, saveSlaPolicyAction } from './actions';

// "Сроки и рабочее время" (FR-SLA-01, FR-SLA-12, раздел 7.4): сроки по приоритету, режим отсчёта, график недели,
// праздники текущего и следующего года. Новые значения действуют на новые расчёты (решение 0032).

const PRIORITIES: readonly Priority[] = ['p1', 'p2', 'p3', 'p4'];
/** Дни в привычном порядке: с понедельника. 0 воскресенье. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DONE = new Set(['policy', 'calendar', 'holidays', 'pickup']);

/** Год и месяц по часовому поясу календаря. */
function localYearMonth(timeZone: string, now = new Date()): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
  return { year: Number(parts.find((p) => p.type === 'year')?.value), month: Number(parts.find((p) => p.type === 'month')?.value) };
}

export default async function SlaSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; line?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const locale = await getLocale();
  const { done, error, line: lineParam } = await searchParams;
  const config = await loadSlaConfig(staff.actor);
  const pickup = await readPickup(staff);
  const nav = await settingsNav('sla');
  const { year, month } = localYearMonth(config.calendar.timeZone);
  const years = [year, year + 1];
  const holidaysOf = (y: number) => config.calendar.holidays.filter((date) => date.startsWith(`${y}-`));
  const nextYearMissing = month === 12 && holidaysOf(year + 1).length === 0;

  return (
    <>
      <PageHeader
        title={t('settings.sla.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: t('settings.sla.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...nav}>
        {done && DONE.has(done) && <Alert tone="success">{t(`settings.sla.done.${done}`)}</Alert>}
        {error === 'holidaysLine' && <Alert tone="danger">{t('settings.sla.errors.holidaysLine', { line: Number(lineParam) || 1 })}</Alert>}
        {error === 'stale_session' && (
          <Alert tone="danger">
            {t('settings.sla.errors.stale_session')}{' '}
            <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}/agent/settings/sla`)}`} className="font-semibold underline">
              {t('settings.sla.reauth')}
            </a>
          </Alert>
        )}
        {error && error !== 'holidaysLine' && error !== 'stale_session' && (
          <Alert tone="danger">{t(error === 'forbidden' ? 'settings.sla.errors.forbidden' : 'settings.sla.errors.invalid_input')}</Alert>
        )}
        {nextYearMissing && <Alert tone="info">{t('settings.sla.holidaysMissing', { year: year + 1 })}</Alert>}
        <p className="text-secondary-foreground">{t('settings.sla.intro')}</p>

        <section aria-labelledby="sla-policies" className="flex flex-col gap-3">
          <h2 id="sla-policies" className="text-lg font-semibold">
            {t('settings.sla.policiesTitle')}
          </h2>
          {PRIORITIES.map((priority) => {
            const policy = config.policies[priority];
            const kind = policy.resolutionDays !== null ? 'days' : 'minutes';
            return (
              <Card key={priority}>
                <CardContent className="pt-6">
                  <form action={saveSlaPolicyAction} className="grid gap-3 tablet:grid-cols-5 tablet:items-end">
                    <input type="hidden" name="priority" value={priority} />
                    <p className="font-semibold tablet:self-center">{priority.toUpperCase()}</p>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`fr-${priority}`}>{t('settings.sla.firstResponse')}</Label>
                      <Input id={`fr-${priority}`} name="firstResponseMinutes" type="number" min={1} required defaultValue={policy.firstResponseMinutes} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`res-${priority}`}>{t('settings.sla.resolution')}</Label>
                      <div className="flex gap-2">
                        <Input id={`res-${priority}`} name="resolutionValue" type="number" min={1} required defaultValue={policy.resolutionDays ?? policy.resolutionMinutes ?? ''} />
                        <Select name="resolutionKind" defaultValue={kind} aria-label={t('settings.sla.resolutionKind')}>
                          <option value="minutes">{t('settings.sla.minutes')}</option>
                          <option value="days">{t('settings.sla.days')}</option>
                        </Select>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`clock-${priority}`}>{t('settings.sla.clock')}</Label>
                      <Select id={`clock-${priority}`} name="clock" defaultValue={policy.clock}>
                        <option value="business">{t('settings.sla.clockBusiness')}</option>
                        <option value="24x7">{t('settings.sla.clock24x7')}</option>
                      </Select>
                    </div>
                    <Button type="submit" variant="secondary">
                      {t('settings.sla.save')}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            );
          })}
          <p className="text-sm text-secondary-foreground">{t('settings.sla.firstResponseHint')}</p>
        </section>

        <section aria-labelledby="sla-calendar" className="flex flex-col gap-3">
          <h2 id="sla-calendar" className="text-lg font-semibold">
            {t('settings.sla.calendarTitle')}
          </h2>
          <Card>
            <CardContent className="pt-6">
              <form action={saveCalendarAction} className="flex flex-col gap-4">
                <div className="flex max-w-sm flex-col gap-1">
                  <Label htmlFor="field-timeZone">{t('settings.sla.timeZone')}</Label>
                  <Input id="field-timeZone" name="timeZone" required defaultValue={config.calendar.timeZone} />
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">{t('settings.sla.week')}</legend>
                  {WEEK_ORDER.map((day) => {
                    const hours = config.calendar.week[day];
                    return (
                      <div key={day} className="grid grid-cols-3 items-center gap-2">
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name={`on${day}`} defaultChecked={hours !== null} className="size-4 accent-primary" />
                          {t(`settings.sla.days7.${day}`)}
                        </label>
                        <Input type="time" name={`from${day}`} defaultValue={hours?.[0] ?? '08:00'} aria-label={t('settings.sla.from', { day: t(`settings.sla.days7.${day}`) })} />
                        <Input type="time" name={`to${day}`} defaultValue={hours?.[1] ?? '20:00'} aria-label={t('settings.sla.to', { day: t(`settings.sla.days7.${day}`) })} />
                      </div>
                    );
                  })}
                </fieldset>
                <Button type="submit" variant="secondary" className="self-start">
                  {t('settings.sla.save')}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="sla-holidays" className="flex flex-col gap-3">
          <h2 id="sla-holidays" className="text-lg font-semibold">
            {t('settings.sla.holidaysTitle')}
          </h2>
          {years.map((y) => (
            <Card key={y}>
              <CardContent className="pt-6">
                <form action={saveHolidaysAction} className="flex flex-col gap-2">
                  <input type="hidden" name="year" value={y} />
                  <Label htmlFor={`holidays-${y}`}>{t('settings.sla.holidaysYear', { year: y })}</Label>
                  <Textarea id={`holidays-${y}`} name="dates" rows={4} defaultValue={holidaysOf(y).join('\n')} aria-describedby={`holidays-${y}-hint`} />
                  <p id={`holidays-${y}-hint`} className="text-sm text-secondary-foreground">
                    {t('settings.sla.holidaysHint')}
                  </p>
                  <Button type="submit" variant="secondary" className="self-start">
                    {t('settings.sla.save')}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ))}
        </section>
        <section aria-labelledby="sla-pickup" className="flex flex-col gap-3">
          <h2 id="sla-pickup" className="text-lg font-semibold">
            {t('settings.sla.pickup.title')}
          </h2>
          <p className="text-secondary-foreground">{t('settings.sla.pickup.intro')}</p>
          <Card>
            <CardContent className="pt-6">
              <form action={savePickupAction} className="flex flex-col gap-3">
                <div className="grid gap-3 tablet:grid-cols-4">
                  {PRIORITIES.map((priority) => (
                    <div key={priority} className="flex flex-col gap-1">
                      <Label htmlFor={`pickup-${priority}`}>{t('settings.sla.pickup.field', { priority: priority.toUpperCase() })}</Label>
                      <Input
                        id={`pickup-${priority}`}
                        name={priority}
                        type="number"
                        min={1}
                        max={100000}
                        defaultValue={pickup[priority] ?? ''}
                        aria-describedby={`pickup-${priority}-hint`}
                      />
                      <p id={`pickup-${priority}-hint`} className="text-sm text-secondary-foreground">
                        {t('settings.sla.pickup.hint', { minutes: config.policies[priority].firstResponseMinutes })}
                      </p>
                    </div>
                  ))}
                </div>
                <Button type="submit" className="self-start">
                  {t('settings.sla.save')}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
        <p className="text-sm text-secondary-foreground">{t('settings.sla.appliesToNew')}</p>
      </SettingsLayout>
    </>
  );
}
