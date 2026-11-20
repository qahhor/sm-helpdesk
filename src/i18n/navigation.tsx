'use client';

import NextLink from 'next/link';
import { useParams, usePathname as useNextPathname } from 'next/navigation';
import type { ComponentProps } from 'react';
import { DEFAULT_LOCALE, isLocale, type Locale } from './locales';
import { localizedHref, stripLocale } from './paths';

// Ссылки и текущий адрес с учётом языка. В коде экранов используются они, а не next/link и
// next/navigation: адрес пишется без языка, язык подставляется сам.
// Язык берётся из первого отрезка адреса, поэтому клиентская часть библиотеки переводов
// и поставщик сообщений для навигации не нужны: первый экран легче на 10 КБ.

/** Язык текущей страницы. */
export function useLocale(): Locale {
  const value = useParams().locale;
  return typeof value === 'string' && isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Ссылка внутри портала. href пишется без языка: "/tickets". */
export function Link({ href, ...props }: Omit<ComponentProps<typeof NextLink>, 'href'> & { href: string }) {
  return <NextLink href={localizedHref(useLocale(), href)} {...props} />;
}

/** Адрес текущей страницы без языка: "/tickets". */
export function usePathname(): string {
  return stripLocale(useLocale(), useNextPathname());
}
