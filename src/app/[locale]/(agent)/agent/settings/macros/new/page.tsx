import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor } from '@/modules/hdu/api';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../../sections';
import { macroEditorProps } from '../editor-props';
import { MacroEditor } from '../MacroEditor';

// Новый макрос (FR-AG-15). Сохраняется включённым: он сразу появляется в меню на странице обращения.
export default async function NewMacroPage() {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const m = await getTranslations('agent.settings.macros');
  const locale = await getLocale();
  const here = `/${locale}/agent/settings/macros/new`;
  const { options, labels } = await macroEditorProps(staff);
  return (
    <>
      <PageHeader
        title={m('editor.newTitle')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: m('title'), href: '/agent/settings/macros' },
          { label: m('editor.newTitle') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('macros')}>
        <MacroEditor initial={{ name: '', isEnabled: true, actions: [] }} options={options} labels={labels} reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`} />
      </SettingsLayout>
    </>
  );
}
