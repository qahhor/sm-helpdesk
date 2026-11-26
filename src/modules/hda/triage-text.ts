import { scanText } from '@/modules/hdc/pref';

// Модуль hda: проверка текста предложений разбора до записи (план M5b, задача 7, решение 18; FR-TRI-02, 11.12).
// Заголовок после принятия видят клиент и коллеги, поэтому он проверяется как текст для клиента: простой текст без
// адресов сайтов и почты, телефонов и чисел длиннее четырёх знаков. Не прошёл: предложения нет, код ничего не
// исправляет за модель. Резюме видит только сотрудник с пометкой "AI, не проверено": у него убираются невидимые знаки
// и лишние пробелы.

const TITLE_MAX = 80;
const SUMMARY_MAX = 300;

/** Адрес сайта со схемой или без: "https://...", "www....", "evil.example". */
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|(?<![\p{L}\p{N}])[\p{L}\p{N}-]+\.(?:[a-z]{2,}|рф|уз)(?![\p{L}\p{N}])/iu;
/** Почта, в том числе с пробелами вокруг "@". */
const EMAIL_LIKE = /@/;
/** Число длиннее четырёх знаков, в том числе разбитое пробелами, точками и дефисами ("12 345 678", "+998 90 ..."). */
const LONG_NUMBER = /\p{Nd}(?:[\s.()+-]*\p{Nd}){4,}/u;
/** Разметка и угловые скобки. */
const MARKUP = /[<>]/;

const tidy = (raw: string) => scanText(raw).replace(/\s+/gu, ' ').trim();

export function safeTriageTitle(raw: string): string | null {
  const title = tidy(raw);
  if (title === '' || title.length > TITLE_MAX) return null;
  if (URL_LIKE.test(title) || EMAIL_LIKE.test(title) || LONG_NUMBER.test(title) || MARKUP.test(title)) return null;
  return title;
}

export function safeTriageSummary(raw: string): string | null {
  const summary = tidy(raw).slice(0, SUMMARY_MAX).trim();
  return summary === '' ? null : summary;
}
