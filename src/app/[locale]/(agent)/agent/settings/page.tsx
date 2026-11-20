import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from './sections';

// "Все настройки": перечень разделов с коротким описанием (образец "Настройки", раздел 8.11 ТЗ).
export default async function SettingsPage() {
  await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const nav = await settingsNav(null);
  return (
    <>
      <PageHeader
        title={t('settings.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...nav}>
        <p className="text-secondary-foreground">{t('settings.overviewIntro')}</p>
        {nav.sections.map((section) => (
          <Card key={section.key}>
            <CardContent className="flex flex-col gap-1 pt-6">
              <Link href={section.href} className="text-base font-semibold text-link underline-offset-2 hover:underline">
                {section.label}
              </Link>
              <p className="text-sm text-secondary-foreground">{t(`settings.sections.${section.key}.text`)}</p>
            </CardContent>
          </Card>
        ))}
      </SettingsLayout>
    </>
  );
}
