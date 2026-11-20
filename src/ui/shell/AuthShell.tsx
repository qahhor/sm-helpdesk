import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/locales';
import { localeNames } from '@/i18n/messages';
import { Logo } from '@/ui/brand/Logo';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';

/**
 * Оболочка страниц без входа: вход клиента и сотрудника, принятие приглашения, одноразовые ссылки.
 * Сначала телефон: одна колонка, крупные поля, одно главное действие на экране (ТЗ 8.1, UX-C-01).
 */
export async function AuthShell({
  children,
  footer,
  wide = false,
}: {
  children: ReactNode;
  /** Строка внизу страницы, например ссылка на политику обработки данных. */
  footer?: ReactNode;
  /** Широкая колонка для текста, который читают, а не заполняют. */
  wide?: boolean;
}) {
  const t = await getTranslations('common');
  return (
    <div data-zone="client" className="flex min-h-dvh flex-col bg-background text-base text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-card px-4 py-3 font-semibold text-link focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('skipToContent')}
      </a>
      <header className="flex h-header shrink-0 items-center gap-2 bg-header px-4 text-header-foreground">
        <Logo onDark withProductName />
        <div className="ms-auto flex items-center">
          <LanguageSwitcher locale={(await getLocale()) as Locale} names={await localeNames()} label={t('language.label')} />
          <ThemeSwitch
            labels={{
              label: t('theme.label'),
              light: t('theme.light'),
              dark: t('theme.dark'),
              system: t('theme.system'),
            }}
          />
        </div>
      </header>
      <main id="main" className={`mx-auto flex w-full flex-1 flex-col gap-4 px-4 py-8 ${wide ? 'max-w-3xl' : 'max-w-md'}`}>
        {children}
      </main>
      {footer && <footer className="mx-auto w-full max-w-md px-4 pb-6 text-center text-sm text-secondary-foreground">{footer}</footer>}
    </div>
  );
}
