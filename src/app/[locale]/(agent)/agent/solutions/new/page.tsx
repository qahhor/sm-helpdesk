import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { LOCALES } from '@/i18n/locales';
import { canWriteSolutions } from '@/modules/hdk/api/editor';
import { TITLE_MAX } from '@/modules/hdk/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { createSolutionAction } from '../actions';

// Новое решение (план M5, задача 3; UX-W-01): язык оригинала, модуль, заголовок и флаг "только через сотрудника".
// После создания открывается редактор с тремя блоками формы.

const ERRORS = new Set(['forbidden', 'invalid_input']);

export default async function NewSolutionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const staff = await requireStaffActor();
  if (!canWriteSolutions(staff)) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.solutions');
  const locale = await getLocale();
  const { error } = await searchParams;
  const modules = await listActiveModules(staff.actor, locale);
  return (
    <>
      <PageHeader
        title={s('newTitle')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/solutions' }, { label: s('newTitle') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      {error && ERRORS.has(error) && <Alert tone="danger">{s(`errors.${error}`)}</Alert>}
      <Card className="max-w-prose">
        <CardContent className="pt-6">
          <form action={createSolutionAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-title">{s('fields.title')}</Label>
              <Input id="new-title" name="title" maxLength={TITLE_MAX} autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-locale">{s('fields.locale')}</Label>
              <Select id="new-locale" name="locale" defaultValue={locale}>
                {LOCALES.map((value) => (
                  <option key={value} value={value}>
                    {s(`locales.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-module">{s('fields.module')}</Label>
              <Select id="new-module" name="moduleId" defaultValue="">
                <option value="">{s('noModule')}</option>
                {modules.map((m) => (
                  <option key={m.moduleId} value={m.moduleId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="internal" className="mt-1 size-4 accent-primary" />
              <span>
                <span className="font-medium">{s('fields.internal')}</span>
                <span className="block text-secondary-foreground">{s('fields.internalHint')}</span>
              </span>
            </label>
            <Button type="submit" className="self-start">
              {s('create')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
