import { FALLBACKS, LOCALES, type Locale } from './locales';

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

/**
 * Сообщения языка, дополненные запасными языками по цепочке FALLBACKS (FR-I18N-05).
 * Посетитель видит текст на запасном языке, а не имя ключа.
 */
export async function loadMessages(
  locale: Locale,
  sources?: Partial<Record<Locale, Messages>>,
): Promise<Messages> {
  // Набор sources задаётся в тестах: языка, которого в нём нет, как будто нет вовсе.
  const read = async (l: Locale) => (sources ? (sources[l] ?? {}) : readSource(l));
  let messages = await read(locale);
  for (const fallback of FALLBACKS[locale]) messages = fillMissing(messages, await read(fallback));
  return messages;
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
