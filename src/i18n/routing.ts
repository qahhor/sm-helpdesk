import { defineRouting } from 'next-intl/routing';
import { DEFAULT_LOCALE, LOCALES } from './locales';

// Язык всегда стоит первым отрезком адреса: /ru/..., /uz/..., /en/...
// Выбор языка для адреса без него делает src/proxy.ts через resolveLocale,
// поэтому определение языка и кука библиотеки выключены.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
  localeDetection: false,
  localeCookie: false,
  alternateLinks: false,
});
