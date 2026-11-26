import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { AI_MODELS, AI_PURPOSES, RESTRICTED_TOPICS, TRIAGE_FIELDS } from '@/modules/hda/api/constants';
import { aiSettingsView } from '@/modules/hda/api/settings';
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
import { liftAiCutoffAction, saveAiModelsAction, saveAiSettingsAction, saveRestrictedTopicsAction } from './actions';

// "AI-помощник" (план M5b, задача 1; FR-ADM-09, FR-AI-17, FR-TRI-04, 9.2): общий переключатель, разбор, порог
// уверенности, пределы и расход за месяц, отключённые организации, модели по целям, отключённые поля разбора. Меняет
// только администратор со свежим входом; каждое изменение пишется в журнал аудита.

const DONE = new Set(['saved', 'models', 'models_changed', 'lifted', 'topics']);
const LANGS = ['ru', 'uz', 'en'] as const;
const ERRORS = new Set(['forbidden', 'invalid_input']);

export default async function AiSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const a = await getTranslations('agent.settings.ai');
  const locale = await getLocale();
  const format = await getFormatter();
  const { done, error } = await searchParams;
  const view = await aiSettingsView(staff);
  const money = (usd: number) => format.number(usd, { style: 'currency', currency: 'USD' });
  const reauth = `/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}/agent/settings/ai`)}`;
  return (
    <>
      <PageHeader
        title={a('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: a('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('ai')}>
        {done && DONE.has(done) && <Alert tone="success">{a(`done.${done}`)}</Alert>}
        {error === 'stale_session' && (
          <Alert tone="danger">
            {a('errors.stale_session')}{' '}
            <a href={reauth} className="font-semibold underline">
              {a('reauth')}
            </a>
          </Alert>
        )}
        {error && ERRORS.has(error) && <Alert tone="danger">{a(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{a('intro')}</p>

        <Card>
          <CardContent className="flex flex-col gap-2 pt-6" data-testid="ai-spend">
            <h2 className="text-lg font-semibold">{a('spend.title')}</h2>
            <p>{a('spend.text', { spent: money(view.spentUsd), budget: money(view.monthlyBudgetUsd) })}</p>
            {view.cutoffs.length === 0 ? (
              <p className="text-sm text-secondary-foreground">{a('spend.noCutoffs')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {view.cutoffs.map((cutoff) => (
                  <li key={cutoff.cutoffId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-words">{cutoff.orgId ? a('spend.cutOrg', { name: cutoff.orgName ?? '' }) : a('spend.cutAll')}</span>
                    <form action={liftAiCutoffAction}>
                      <input type="hidden" name="cutoffId" value={cutoff.cutoffId} />
                      <Button type="submit" variant="secondary" size="small">
                        {a('spend.lift')}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <form action={saveAiSettingsAction} className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">{a('general.title')}</h2>
              <label className="inline-flex min-h-control items-center gap-3">
                <input type="checkbox" name="enabled" defaultChecked={view.enabled} className="size-5 accent-primary" aria-describedby="ai-enabled-hint" />
                {a('general.enabled')}
              </label>
              <p id="ai-enabled-hint" className="text-sm text-secondary-foreground">
                {a('general.enabledHint')}
              </p>
              <label className="inline-flex min-h-control items-center gap-3">
                <input type="checkbox" name="triageEnabled" defaultChecked={view.triageEnabled} className="size-5 accent-primary" />
                {a('general.triageEnabled')}
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ai-min-score">{a('general.minScore')}</Label>
                  <Input id="ai-min-score" name="minScore" type="number" min={0} max={10} step="any" required defaultValue={view.minScore} aria-describedby="ai-min-score-hint" />
                  <p id="ai-min-score-hint" className="text-sm text-secondary-foreground">
                    {a('general.minScoreHint')}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ai-budget">{a('general.budget')}</Label>
                  <Input id="ai-budget" name="monthlyBudgetUsd" type="number" min={0} max={100000} step="any" required defaultValue={view.monthlyBudgetUsd} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ai-user-limit">{a('general.userLimit')}</Label>
                  <Input id="ai-user-limit" name="userDailyLimit" type="number" min={0} max={10000} step={1} required defaultValue={view.userDailyLimit} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ai-org-limit">{a('general.orgLimit')}</Label>
                  <Input id="ai-org-limit" name="orgDailyLimit" type="number" min={0} max={100000} step={1} required defaultValue={view.orgDailyLimit} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ai-cutoff">{a('general.cutoff')}</Label>
                  <Input id="ai-cutoff" name="cutoffPercent" type="number" min={1} max={100} step={1} required defaultValue={Math.round(view.cutoffShare * 100)} aria-describedby="ai-cutoff-hint" />
                  <p id="ai-cutoff-hint" className="text-sm text-secondary-foreground">
                    {a('general.cutoffHint')}
                  </p>
                </div>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-semibold">{a('general.fieldsOff')}</legend>
                <p className="text-sm text-secondary-foreground">{a('general.fieldsOffHint')}</p>
                {TRIAGE_FIELDS.map((field) => (
                  <label key={field} className="inline-flex min-h-control items-center gap-3">
                    <input type="checkbox" name="triageFieldsOff" value={field} defaultChecked={view.triageFieldsOff.includes(field)} className="size-5 accent-primary" />
                    {a(`fields.${field}`)}
                  </label>
                ))}
              </fieldset>
              <Button type="submit" className="self-start">
                {a('save')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <form action={saveRestrictedTopicsAction} className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">{a('topics.title')}</h2>
              <p className="text-sm text-secondary-foreground">{a('topics.intro')}</p>
              {RESTRICTED_TOPICS.map((topic) => (
                <fieldset key={topic} className="flex flex-col gap-2">
                  <legend className="mb-1 font-semibold">{a(`topics.names.${topic}`)}</legend>
                  <div className="grid gap-2 md:grid-cols-3">
                    {LANGS.map((lang) => (
                      <div key={lang} className="flex flex-col gap-1">
                        <Label htmlFor={`topic-${topic}-${lang}`}>{a(`topics.langs.${lang}`)}</Label>
                        <Textarea id={`topic-${topic}-${lang}`} name={`${topic}.${lang}`} rows={4} defaultValue={view.restrictedTopics[topic][lang].join('\n')} />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
              <Button type="submit" variant="secondary" className="self-start">
                {a('topics.save')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <form action={saveAiModelsAction} className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">{a('models.title')}</h2>
              <p className="text-sm text-secondary-foreground">{a('models.intro')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {AI_PURPOSES.map((purpose) => (
                  <div key={purpose} className="flex flex-col gap-1">
                    <Label htmlFor={`ai-model-${purpose}`}>{a(`purposes.${purpose}`)}</Label>
                    <Select id={`ai-model-${purpose}`} name={purpose} defaultValue={view.effectiveModels[purpose]}>
                      {!(AI_MODELS as readonly string[]).includes(view.effectiveModels[purpose]) && <option value={view.effectiveModels[purpose]}>{view.effectiveModels[purpose]}</option>}
                      {AI_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {a(`modelNames.${model}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
              <Button type="submit" variant="secondary" className="self-start">
                {a('models.save')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
