import 'server-only';
import { z } from 'zod';
import { DEFAULT_LOCALE, isLocale, type Locale } from './locales';

// Проверка входа серверного действия "выбор языка". Действие доступно всем,
// поэтому значения из браузера не используются, пока не прошли проверку.

// Адрес внутри портала: начинается с одной косой черты, без пробелов, управляющих знаков,
// обратной косой черты и без подъёма по каталогам.
const insidePath = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[A-Za-z0-9\-._~%/]*$/)
  .refine((path) => !path.split('/').includes('..') && !path.includes('//'));

/** Язык только из списка портала, адрес только внутри портала. Иначе язык по умолчанию и главная. */
export function parseLocaleChoice(locale: unknown, pathname: unknown): { locale: Locale; path: string } {
  const path = insidePath.safeParse(pathname);
  return {
    locale: typeof locale === 'string' && isLocale(locale) ? locale : DEFAULT_LOCALE,
    path: path.success ? path.data : '/',
  };
}
