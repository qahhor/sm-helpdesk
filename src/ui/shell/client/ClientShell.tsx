import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/locales';
import { localeNames } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { Logo } from '@/ui/brand/Logo';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';
import { BottomNav } from './BottomNav';
import { CLIENT_NAV, type ClientNavItem } from './nav-config';
import { TopNav } from './TopNav';

/**
 * Оболочка кабинета клиента: сначала телефон (ТЗ 8.1).
 * Шапка 52 px как в Smartup Web. До 600 px навигация в нижней панели, от 600 px в строке под шапкой.
 * data-zone="client" включает размеры зоны клиента: текст 16 px, цель нажатия не меньше 44 px.
 */
export async function ClientShell({ children }: { children: ReactNode }) {
  const t = await getTranslations();
  const items: ClientNavItem[] = CLIENT_NAV.map(({ key, href }) => ({ key, href, label: t(`client.nav.${key}`) }));
  const navLabel = t('client.nav.label');

  return (
    <div data-zone="client" className="flex min-h-dvh flex-col bg-background text-base text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-card px-4 py-3 font-semibold text-link focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('common.skipToContent')}
      </a>
      <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-2 bg-header px-4 text-header-foreground">
        <Link href="/" className="inline-flex items-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Logo onDark withProductName />
        </Link>
        <div className="ms-auto flex items-center">
          <LanguageSwitcher
            locale={(await getLocale()) as Locale}
            names={await localeNames()}
            label={t('common.language.label')}
          />
          <ThemeSwitch
            labels={{
              label: t('common.theme.label'),
              light: t('common.theme.light'),
              dark: t('common.theme.dark'),
              system: t('common.theme.system'),
            }}
          />
        </div>
      </header>
      <TopNav items={items} label={navLabel} />
      <main id="main" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pb-24 pt-6 tablet:pb-8">
        {children}
      </main>
      <BottomNav items={items} label={navLabel} />
    </div>
  );
}
