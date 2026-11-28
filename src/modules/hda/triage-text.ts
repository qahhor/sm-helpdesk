import { scanText } from '@/modules/hdc/pref';
import { matchRestrictedTopic, RESTRICTED_TOPICS_DEFAULT, type TopicLists } from './topics';

// Модуль hda: проверка текста предложений разбора до записи (план M5b, задача 7, решение 18; FR-TRI-02, 11.12).
// Заголовок после принятия видят клиент и коллеги, поэтому он проверяется как текст для клиента: простой текст без
// адресов сайтов и почты, телефонов и чисел длиннее четырёх знаков. Не прошёл: предложения нет, код ничего не
// исправляет за модель. Заголовок со словом обязательной темы (списки topics: договор, оплата, жалоба и другие) или с
// адресом, записанным словами ("узел точка com", "собака", название мессенджера), тоже не предлагается (волна 7,
// S-M6): такой текст клиенту пишет только сотрудник. Резюме видит только сотрудник с пометкой "AI, не проверено": у него убираются невидимые знаки
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

/** Адрес словами: "узел точка com", "uzel nuqta uz", "(dot)"; слово вместо знака почты; название мессенджера. */
const SPELLED_ADDRESS = /[\p{L}\p{N}_-]{2,}[\s([{]+(?:точка|тчк|dot|nuqta)[\s)\]}]+(?:com|net|org|ru|uz|io|info|biz|xyz|kz|su|me|рф|ком|ру|уз|орг)(?![\p{L}\p{N}])/iu;
const AT_WORD = /(?<![\p{L}\p{N}])(?:собака|собачка|sobaka|kuchukcha)(?![\p{L}\p{N}])|[([{]\s*(?:at|dot)\s*[)\]}]/iu;
const MESSENGER = /(?<![\p{L}\p{N}])(?:telegram|телеграм|whatsapp|ватсап|вотсап|viber|вайбер)\p{L}*/iu;

export function safeTriageTitle(raw: string, topics: TopicLists = RESTRICTED_TOPICS_DEFAULT): string | null {
  const title = tidy(raw);
  if (title === '' || title.length > TITLE_MAX) return null;
  if (URL_LIKE.test(title) || EMAIL_LIKE.test(title) || LONG_NUMBER.test(title) || MARKUP.test(title)) return null;
  if (SPELLED_ADDRESS.test(title) || AT_WORD.test(title) || MESSENGER.test(title)) return null;
  if (matchRestrictedTopic(title, topics) !== null) return null;
  return title;
}

export function safeTriageSummary(raw: string): string | null {
  const summary = tidy(raw).slice(0, SUMMARY_MAX).trim();
  return summary === '' ? null : summary;
}
