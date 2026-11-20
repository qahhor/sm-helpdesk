import { getTranslations } from 'next-intl/server';
import { localeNames } from '@/i18n/messages';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';

// Главная кабинета клиента. Оболочка с шапкой и навигацией появляется в задаче 9 вехи M0.
export default async function ClientHomePage() {
  const t = await getTranslations();
  return (
    <main data-zone="client" className="mx-auto flex max-w-2xl flex-col gap-6 p-6 text-base">
      <div className="flex items-center justify-end gap-2">
        <LanguageSwitcher names={await localeNames()} label={t('common.language.label')} />
        <ThemeSwitch
          labels={{
            label: t('common.theme.label'),
            light: t('common.theme.light'),
            dark: t('common.theme.dark'),
            system: t('common.theme.system'),
          }}
        />
      </div>
      <h1 className="text-2xl font-bold">{t('client.home.title')}</h1>
      <p className="text-secondary-foreground">{t('client.tickets.empty')}</p>
    </main>
  );
}
