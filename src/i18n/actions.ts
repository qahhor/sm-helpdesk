'use server';

import { cookies } from 'next/headers';
import { getEnv } from '@/env';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './locales';
import { redirect } from './navigation';

/**
 * Посетитель выбрал язык: запомнить выбор на год и открыть ту же страницу на новом языке.
 *
 * Серверное действие доступно всем, поэтому оба значения проверяются:
 * язык только из списка портала, адрес только внутри портала.
 */
export async function chooseLocale(locale: string, pathname: string): Promise<void> {
  const chosen = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const inside = typeof pathname === 'string' && /^\/(?![/\\])/.test(pathname) && !pathname.includes('\\');
  const store = await cookies();
  store.set(LOCALE_COOKIE, chosen, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    httpOnly: true,
    secure: getEnv().HUB_URL.startsWith('https:'),
  });
  redirect({ href: inside ? pathname : '/', locale: chosen });
}
