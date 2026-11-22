import { getLocale, getTranslations } from 'next-intl/server';
import { listActiveModules, listAllTemplates } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';
import { TemplateForm } from './TemplateForm';

// "Шаблоны ответов" (FR-AG-06): заготовки на языках портала, вызываются кодом после "/" в поле ответа.
// Ведёт администратор, сотрудники только вставляют.

const ERRORS = new Set(['forbidden', 'invalid_input', 'shortcut_taken']);

export default async function TemplatesSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const { done, error } = await searchParams;
  const [templates, modules] = await Promise.all([listAllTemplates(staff), listActiveModules(staff.actor, await getLocale())]);
  const nav = await settingsNav('templates');
  const moduleName = (id: string | null) => (id ? (modules.find((m) => m.moduleId === id)?.name ?? '') : t('settings.templates.anyModule'));
  return (
    <>
      <PageHeader
        title={t('settings.templates.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: t('settings.templates.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...nav}>
        {done === 'saved' && <Alert tone="success">{t('settings.templates.saved')}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{t(`settings.templates.errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{t('settings.templates.intro')}</p>
        {templates.map((template) => (
          <Card key={template.templateId}>
            <CardContent className="pt-6">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <code className="font-semibold">/{template.shortcut}</code>
                  <span>{template.title}</span>
                  <span className="text-sm text-muted-foreground">{moduleName(template.moduleId)}</span>
                  {!template.isEnabled && <StatusLabel tone="gray">{t('settings.templates.disabled')}</StatusLabel>}
                </summary>
                <div className="pt-4">
                  <TemplateForm template={template} modules={modules} />
                </div>
              </details>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <h2 className="text-lg font-semibold">{t('settings.templates.newTitle')}</h2>
            <TemplateForm template={null} modules={modules} />
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
