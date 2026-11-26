import { getLocale, getTranslations } from 'next-intl/server';
import { searchSettingsText, type SearchSettingKind } from '@/modules/hdk/api/search-settings';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { Textarea } from '@/ui/components/textarea';
import { settingsNav } from '../sections';
import { saveSearchSettingAction } from './actions';

// "Поиск" (план W6, задача 9; ответ владельца 0070, пункт 4): синонимы, словарь узбекского и курирование решений ведёт
// администратор поддержки. Каждый набор сохраняется целиком своей формой; в Typesense он уходит за секунды задачей
// search.sync. Пока поиск идёт через PostgreSQL (SEARCH_PROVIDER=postgres), наборы хранятся и начнут действовать
// после включения Typesense.

const KINDS: SearchSettingKind[] = ['synonyms', 'stems', 'curation'];
const ERRORS = new Set(['forbidden', 'invalid_input']);

export default async function SearchSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; kind?: string; line?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.settings.search');
  const locale = await getLocale();
  const { done, error, kind, line } = await searchParams;
  const texts = await searchSettingsText(staff);
  return (
    <>
      <PageHeader
        title={s('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: s('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('search')}>
        {done && (KINDS as string[]).includes(done) && <Alert tone="success">{s(`${done as SearchSettingKind}.saved`)}</Alert>}
        {error === 'line' && kind && (KINDS as string[]).includes(kind) && (
          <Alert tone="danger">{s('errors.line', { line: Number(line ?? 0) || 0, section: s(`${kind as SearchSettingKind}.title`) })}</Alert>
        )}
        {error === 'stale_session' && (
          <Alert tone="danger">
            {s('errors.stale_session')}{' '}
            <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}/agent/settings/search`)}`} className="font-semibold underline">
              {s('reauth')}
            </a>
          </Alert>
        )}
        {error && ERRORS.has(error) && <Alert tone="danger">{s(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{s('intro')}</p>
        {KINDS.map((k) => (
          <Card key={k}>
            <CardContent className="pt-6">
              <form action={saveSearchSettingAction} className="flex flex-col gap-2">
                <input type="hidden" name="kind" value={k} />
                <h2 className="text-lg font-semibold">{s(`${k}.title`)}</h2>
                <p id={`search-${k}-intro`} className="text-sm text-secondary-foreground">
                  {s(`${k}.intro`)}
                </p>
                <Label htmlFor={`search-${k}`}>{s(`${k}.label`)}</Label>
                <Textarea id={`search-${k}`} name="text" rows={8} defaultValue={texts[k]} placeholder={s(`${k}.example`)} aria-describedby={`search-${k}-intro`} />
                <Button type="submit" variant="secondary" className="self-start">
                  {s(`${k}.save`)}
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
      </SettingsLayout>
    </>
  );
}
