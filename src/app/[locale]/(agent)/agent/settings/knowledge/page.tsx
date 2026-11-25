import { getLocale, getTranslations } from 'next-intl/server';
import { aiDailyLimitSetting } from '@/modules/hda/api/settings';
import { allowedDomainsSetting } from '@/modules/hdk/api/publish';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Input } from '@/ui/components/input';
import { Card, CardContent } from '@/ui/components/card';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { Textarea } from '@/ui/components/textarea';
import { settingsNav } from '../sections';
import { saveAiLimitAction, saveAllowedDomainsAction } from './actions';

// "Решения" (план M5, задача 4; FR-SOL-04): разрешённые домены ссылок. Ссылка решения на другой домен не публикуется
// вовсе; ссылки внутрь портала разрешены всегда. Пустой список: внешние ссылки не публикуются. Там же суточный предел
// вызовов AI на черновики и переводы (план M5, решение 13).

const ERRORS = new Set(['forbidden', 'invalid_input']);

export default async function KnowledgeSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; value?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const k = await getTranslations('agent.settings.knowledge');
  const locale = await getLocale();
  const { done, error, value } = await searchParams;
  const domains = await allowedDomainsSetting(staff);
  const aiLimit = await aiDailyLimitSetting(staff);
  return (
    <>
      <PageHeader
        title={k('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: k('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('knowledge')}>
        {done === 'saved' && <Alert tone="success">{k('saved')}</Alert>}
        {done === 'ai_limit' && <Alert tone="success">{k('aiLimit.saved')}</Alert>}
        {error === 'ai_limit' && <Alert tone="danger">{k('aiLimit.invalid')}</Alert>}
        {error === 'domain' && <Alert tone="danger">{k('errors.domain', { value: (value ?? '').slice(0, 100) })}</Alert>}
        {error === 'stale_session' && (
          <Alert tone="danger">
            {k('errors.stale_session')}{' '}
            <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}/agent/settings/knowledge`)}`} className="font-semibold underline">
              {k('reauth')}
            </a>
          </Alert>
        )}
        {error && ERRORS.has(error) && <Alert tone="danger">{k(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{k('intro')}</p>
        {domains.length === 0 && <Alert tone="info">{k('empty')}</Alert>}
        <Card>
          <CardContent className="pt-6">
            <form action={saveAllowedDomainsAction} className="flex flex-col gap-2">
              <Label htmlFor="allowed-domains">{k('label')}</Label>
              <Textarea id="allowed-domains" name="domains" rows={6} defaultValue={domains.join('\n')} aria-describedby="allowed-domains-hint" />
              <p id="allowed-domains-hint" className="text-sm text-secondary-foreground">
                {k('hint')}
              </p>
              <Button type="submit" variant="secondary" className="self-start">
                {k('save')}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <h2 className="text-lg font-semibold">{k('aiLimit.title')}</h2>
            <p id="ai-limit-intro" className="text-sm text-secondary-foreground">
              {k('aiLimit.intro')}
            </p>
            <form action={saveAiLimitAction} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="ai-limit">{k('aiLimit.label')}</Label>
                <Input id="ai-limit" name="limit" type="number" min={0} max={10000} step={1} required defaultValue={aiLimit} aria-describedby="ai-limit-intro" />
              </div>
              <Button type="submit" variant="secondary">
                {k('aiLimit.save')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
