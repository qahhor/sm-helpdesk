import { dropBrokenMessages } from './icu';
import { DEFAULT_LOCALE, FALLBACKS, LOCALES, type Locale } from './locales';

export type Messages = { [key: string]: string | Messages };

/** Сообщения языка как они записаны в файле, без запасных языков. */
async function readSource(locale: Locale): Promise<Messages> {
  return (await import(`../../messages/${locale}.json`)).default as Messages;
}

/** Дополняет target ключами из source, которых в target нет. Объекты не меняет, возвращает новый. */
function fillMissing(target: Messages, source: Messages): Messages {
  const result: Messages = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const own = result[key];
    if (own === undefined) result[key] = value;
    else if (typeof own === 'object' && typeof value === 'object') result[key] = fillMissing(own, value);
  }
  return result;
}

async function build(locale: Locale, read: (locale: Locale) => Promise<Messages>): Promise<Messages> {
  const reference = await read(DEFAULT_LOCALE);
  let messages = dropBrokenMessages(await read(locale), reference);
  for (const fallback of FALLBACKS[locale])
    messages = fillMissing(messages, dropBrokenMessages(await read(fallback), reference));
  return messages;
}

// Файлы сообщений не меняются во время работы: результат считается один раз на язык.
const cache = new Map<Locale, Promise<Messages>>();

/**
 * Сообщения языка, дополненные запасными языками по цепочке FALLBACKS (FR-I18N-05).
 * Недостающая или сломанная строка заменяется текстом запасного языка: посетитель не видит имя ключа.
 */
export async function loadMessages(
  locale: Locale,
  sources?: Partial<Record<Locale, Messages>>,
): Promise<Messages> {
  // Набор sources задаётся в тестах: языка, которого в нём нет, как будто нет вовсе.
  if (sources) return build(locale, async (l) => sources[l] ?? {});
  let cached = cache.get(locale);
  if (!cached) {
    cached = build(locale, readSource);
    cache.set(locale, cached);
  }
  return cached;
}

/** Название каждого языка на нём самом: ключ common.language.self его файла. */
export async function localeNames(): Promise<Record<Locale, string>> {
  const entries = await Promise.all(
    LOCALES.map(async (locale) => {
      const common = (await readSource(locale)).common as { language?: { self?: string } } | undefined;
      return [locale, common?.language?.self ?? locale] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Locale, string>;
}
