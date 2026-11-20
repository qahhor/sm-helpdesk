import { FORMAT_LOCALES, type Locale, TIME_ZONE } from './locales';

// Даты и числа по правилам языка (FR-I18N-07, FR-I18N-08).
// Часовой пояс задаётся явно: сервер и браузер должны показать одно и то же.

/** Дата: 11.11.2026 для русского и узбекского, 11 Nov 2026 для английского. */
export function formatDate(d: Date, locale: Locale, timeZone: string = TIME_ZONE): string {
  const { date } = FORMAT_LOCALES[locale];
  const numeric = date === 'ru-RU';
  return new Intl.DateTimeFormat(date, {
    day: numeric ? '2-digit' : 'numeric',
    month: numeric ? '2-digit' : 'short',
    year: 'numeric',
    timeZone,
  }).format(d);
}

/** Дата и время: 11.11.2026, 00:30. Часы всегда в 24-часовой записи. */
export function formatDateTime(d: Date, locale: Locale, timeZone: string = TIME_ZONE): string {
  const time = new Intl.DateTimeFormat(FORMAT_LOCALES[locale].date, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(d);
  return `${formatDate(d, locale, timeZone)}, ${time}`;
}

/** Число с разрядами: 1 250 000 (неразрывный пробел) или 1,250,000. */
export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(FORMAT_LOCALES[locale].number, { useGrouping: 'always' }).format(n);
}
