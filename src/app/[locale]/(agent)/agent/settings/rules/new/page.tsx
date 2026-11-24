import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor } from '@/modules/hdu/api';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../../sections';
import { ruleEditorProps } from '../editor-props';
import { RuleEditor } from '../RuleEditor';
import { EMPTY_DRAFT } from '../rule-draft';

// Новое правило автоматизации (FR-AUTO-01). Сохраняется выключенным: сначала пробный прогон, потом включение в списке.
export default async function NewRulePage() {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const r = await getTranslations('agent.settings.rules');
  const locale = await getLocale();
  const here = `/${locale}/agent/settings/rules/new`;
  const { options, labels } = await ruleEditorProps(staff, null);
  return (
    <>
      <PageHeader
        title={r('editor.newTitle')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: r('title'), href: '/agent/settings/rules' },
          { label: r('editor.newTitle') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('rules')}>
        <RuleEditor initial={EMPTY_DRAFT} options={options} labels={labels} reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`} state={labels.newDisabled} />
      </SettingsLayout>
    </>
  );
}
