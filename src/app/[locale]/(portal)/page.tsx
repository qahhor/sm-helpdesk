import { getTranslations } from 'next-intl/server';
import { localeNames } from '@/i18n/messages';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';

// Главная кабинета клиента. Оболочка с шапкой и навигацией появляется в задаче 9 вехи M0.
export default async function ClientHomePage() {
  const t = await getTranslations();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex justify-end">
        <LanguageSwitcher names={await localeNames()} label={t('common.language.label')} />
      </div>
      <h1 className="text-2xl font-bold">{t('client.home.title')}</h1>
      <p>{t('client.tickets.empty')}</p>
    </main>
  );
}
