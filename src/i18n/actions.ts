'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getEnv } from '@/env';
import { rememberMyLocale } from '@/modules/hdu/api';
import { parseLocaleChoice } from './locale-choice';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './locales';
import { localizedHref } from './paths';

/**
 * Посетитель выбрал язык: запомнить выбор на год и открыть ту же страницу на новом языке.
 * Вошедшему пользователю выбор запоминается и в учётной записи.
 * Вход проверяет parseLocaleChoice: язык только из списка портала, адрес только внутри портала.
 */
export async function chooseLocale(locale: string, pathname: string): Promise<void> {
  const choice = parseLocaleChoice(locale, pathname);
  const store = await cookies();
  store.set(LOCALE_COOKIE, choice.locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    httpOnly: true,
    secure: getEnv().HUB_URL.startsWith('https:'),
  });
  // Вошедшему пользователю язык запоминается и в учётной записи: на нём придут письма и сообщения бота.
  await rememberMyLocale(choice.locale);
  redirect(localizedHref(choice.locale, choice.path));
}
