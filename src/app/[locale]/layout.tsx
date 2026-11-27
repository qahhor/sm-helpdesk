import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { isLocale } from '@/i18n/locales';
import { StyleNonce } from '@/security/StyleNonce';
import { ThemeApply } from '@/ui/theme/ThemeApply';
import { ThemeScript } from '@/ui/theme/ThemeScript';
import '../globals.css';

// Корневая раскладка: язык берётся из первого отрезка адреса.
// Все страницы портала динамические: данные арендаторов не кешируются (ТЗ 9.4, правило 6).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');
  return { title: t('appName') };
}

export default async function LocaleLayout({ children, params }: LayoutProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  // Одноразовый код запроса для политики CSP. Его ставит src/proxy.ts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    // Класс dark ставит скрипт темы до отрисовки, поэтому разметка сервера и браузера здесь различается.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body>
        <StyleNonce />
        {/* Страница "не найдено" собирается в браузере, где скрипт темы не выполняется (план M9, решение 23). */}
        <ThemeApply />
        {/* Тексты переводятся на сервере и приходят компонентам готовыми строками: библиотека сообщений
            и сами сообщения в браузер не отправляются. Клиентскому экрану, которому нужны переводы,
            поставщик сообщений подключается на его странице с нужной частью сообщений. */}
        {children}
      </body>
    </html>
  );
}
