import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { Locale } from '@/i18n/locales';
import { localeNames } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { Logo } from '@/ui/brand/Logo';
import { cn } from '@/ui/cn';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';
import { BottomNav } from './BottomNav';
import { CLIENT_NAV, type ClientNavItem } from './nav-config';
import { TopNav } from './TopNav';

/**
 * Оболочка кабинета клиента: сначала телефон (ТЗ 8.1).
 * Шапка 52 px как в Smartup Web. До 600 px навигация в нижней панели, от 600 px в строке под шапкой.
 * data-zone="client" включает размеры зоны клиента: текст 16 px, цель нажатия не меньше 44 px.
 * Активную организацию (org), колокольчик уведомлений (bell) и меню пользователя (userMenu) строит раскладка кабинета
 * из проверенной сессии.
 */
export async function ClientShell({
  children,
  org,
  userMenu,
  bell,
  support,
}: {
  children: ReactNode;
  org?: ReactNode;
  userMenu?: ReactNode;
  bell?: ReactNode;
  /** Показываемый адрес поддержки (решение 23 вехи M4): подвал кабинета. Не задан: подвала нет. */
  support?: string | null;
}) {
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
          {/* С организацией в шапке на телефоне не хватает места: название продукта читает программа экранного доступа. */}
          <Logo onDark withProductName className={org ? 'max-tablet:[&>span]:sr-only' : undefined} />
        </Link>
        {org && <div className="flex min-w-0 items-center">{org}</div>}
        <div className="ms-auto flex shrink-0 items-center">
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
          {bell}
          {userMenu}
        </div>
      </header>
      <TopNav items={items} label={navLabel} />
      <main id="main" className={cn('mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-6', support ? 'pb-6' : 'pb-24 tablet:pb-8')}>
        {children}
      </main>
      {support && (
        <footer className="mx-auto w-full max-w-3xl px-4 pb-24 text-sm text-secondary-foreground tablet:pb-8">
          <p className="border-t border-border pt-4">
            {t.rich('client.footer.support', {
              address: () => (
                <a href={`mailto:${support}`} className="text-link underline underline-offset-2">
                  {support}
                </a>
              ),
            })}
          </p>
        </footer>
      )}
      <BottomNav items={items} label={navLabel} />
    </div>
  );
}
