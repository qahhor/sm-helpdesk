import { cleanUserText } from '@/modules/hdc/pref';
import { AI_INPUT_MAX_CHARS, AI_PRICE_PER_MTOK, type AiTier } from './pref';

// Модуль hda, слой util: подготовка текста для модели без обращения к базе (ТЗ 14.3, поправка 101; план M5, задача 5).
//
// В модель уходит только перечень раздела 14.3. Перед отправкой каждый текст:
//   - очищается от невидимых знаков (знаки-теги Юникода, смена направления, нулевая ширина, селекторы вариантов):
//     модель читает их как буквы, а сотрудник на экране их не видит (проверка на AI-инъекции, "Исправлено сейчас");
//   - теряет адреса email и номера телефонов (а заодно ИНН, ПИНФЛ и другие длинные числа): на их месте метка;
//   - теряет известные имена участников и название организации: на их месте "Клиент", "Сотрудник", "Организация";
//   - экранирует угловые скобки: текст клиента не может закрыть тег данных и выйти из него в инструкции.

/** Метки на месте вырезанного. Модель видит, что здесь что-то было, но не видит что. */
export const REDACTED = { email: '[email]', phone: '[phone]', client: 'Клиент', staff: 'Сотрудник', org: 'Организация' } as const;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/** Телефон: цифры группами через пробел, дефис или скобки (точка нет: даты и версии), с плюсом или без, от 7 цифр. */
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\d{1,4}\)?(?:[\s-]?\(?\d{2,4}\)?){2,5}(?![\p{L}\p{N}])/gu;
/** Длинное число подряд: телефон без разделителей, ИНН (9), ПИНФЛ (14), номер карты. */
const DIGIT_RUN = /(?<!\d)\d{7,}(?!\d)/g;
/** Соединители и селекторы вариантов, которые cleanUserText оставляет одиночными (они законны в эмодзи). */
const JOINERS = /[‌‍︀-️]/gu;

/** Текст для модели: без невидимых знаков, адресов почты и телефонов. */
export function sanitizeForAi(text: string): string {
  return cleanUserText(text)
    .replace(JOINERS, '')
    .replace(EMAIL, REDACTED.email)
    .replace(PHONE, (match) => (match.replace(/\D/g, '').length >= 7 ? REDACTED.phone : match))
    .replace(DIGIT_RUN, REDACTED.phone);
}

/** Замена известных слов (имена, название организации) меткой, без учёта регистра, только целым словом. */
export function redactTerms(text: string, terms: readonly { term: string; label: string }[]): string {
  let out = text;
  // Длинные первыми: "Иван Петров" раньше "Иван".
  for (const { term, label } of [...terms].sort((a, b) => b.term.length - a.term.length)) {
    const clean = term.trim();
    if (clean.length < 2) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), label);
  }
  return out;
}

/** Угловые скобки текстом: данные не закрывают тег, в котором лежат. */
export function escapeData(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обрезка входа по пределу знаков (проверка на AI-инъекции, пункт 5). */
export function clip(text: string, max = AI_INPUT_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Стоимость вызова в долларах по токенам и уровню модели (шесть знаков после запятой). */
export function costUsd(tier: AiTier, usage: { inputTokens: number; outputTokens: number }): number {
  const price = AI_PRICE_PER_MTOK[tier];
  return Math.round(((usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000) * 1e6) / 1e6;
}

/**
 * JSON из текста ответа модели: модель иногда оборачивает его в ограждение кода или добавляет слова. Берётся текст от
 * первой открывающей до последней закрывающей фигурной скобки. Нет такого: null.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
