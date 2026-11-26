// Языки портала. Единственное место, где они перечислены.
//
// Новый язык добавляется тремя шагами:
//   1. код в LOCALES и по строке в FALLBACKS и FORMAT_LOCALES ниже;
//   2. файл messages/<код>.json;
//   3. pnpm check (покажет недостающие ключи).

export const LOCALES = ['ru', 'uz', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';

/** Откуда брать текст, если в языке нет ключа (FR-I18N-05). Порядок задаёт приоритет. */
export const FALLBACKS: Record<Locale, readonly Locale[]> = {
  ru: ['en'],
  uz: ['ru', 'en'],
  en: ['ru'],
};

/**
 * Правила записи дат и чисел. Русский и узбекский: 10.11.2026 и 1 250 000
 * (правило голоса, ТЗ 8.13). Английский: 10 Nov 2026 и 1,250,000.
 */
export const FORMAT_LOCALES: Record<Locale, { date: string; number: string }> = {
  ru: { date: 'ru-RU', number: 'ru-RU' },
  uz: { date: 'ru-RU', number: 'ru-RU' },
  en: { date: 'en-GB', number: 'en-US' },
};

/** Все даты портала показываются по времени Ташкента (FR-I18N-08). */
export const TIME_ZONE = 'Asia/Tashkent';

/** Кука с языком, который выбрал посетитель. Срок: год. */
export const LOCALE_COOKIE = 'hub_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Имя куки языка: на https с приставкой __Host- (только этот хост, Secure, Path=/; ASVS 5.0.0, требования 3.3.1 и
 * 3.3.3), на http без неё: браузер не принял бы __Host- без Secure. Как у кук входа (решение 0021).
 */
export const localeCookieName = (https: boolean): string => (https ? `__Host-${LOCALE_COOKIE}` : LOCALE_COOKIE);

/** Язык из кук запроса: кука с приставкой важнее прежней без неё. */
export function localeFromCookies(cookies: { get(name: string): { value: string } | undefined }): string | undefined {
  return cookies.get(localeCookieName(true))?.value ?? cookies.get(localeCookieName(false))?.value;
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
