import type { Locale } from './locales';

/** Адрес страницы с языком: localizedHref('uz', '/tickets') даёт /uz/tickets, для главной /uz. */
export function localizedHref(locale: Locale, href: string): string {
  return href === '/' ? `/${locale}` : `/${locale}${href}`;
}

/** Адрес страницы без языка: stripLocale('uz', '/uz/tickets') даёт /tickets, для главной /. */
export function stripLocale(locale: Locale, pathname: string): string {
  const prefix = `/${locale}`;
  if (pathname === prefix) return '/';
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}
