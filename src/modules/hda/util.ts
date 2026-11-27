import { createHmac } from 'node:crypto';
import { logEvent } from '@/lib/log';
import { phoneLike, scanText } from '@/modules/hdc/pref';
import { AI_INPUT_MAX_CHARS, AI_MODELS, AI_PRICE_PER_MTOK, type AiModel } from './pref';

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

/** Адрес почты; пробел по краям "@" не спасает адрес ("ivan @ mail.ru"). */
const EMAIL = /[\p{L}\p{N}._%+-]+ ?@ ?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
/**
 * Телефон: цифры группами через пробел, дефис, скобки, точку или косую черту, с плюсом или без, от 7 цифр. С точкой
 * или косой чертой только от 9 цифр и с одним и тем же разделителем: так даты (25.11.2026, 25.11.2026 10:30) и версии
 * остаются текстом (повторная проверка M5, docs/decisions/0057).
 */
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\p{Nd}{1,4}\)?(?:[\s./-]?\(?\p{Nd}{2,4}\)?){2,5}(?![\p{L}\p{N}])/gu;
/** Длинное число подряд: телефон без разделителей, ИНН (9), ПИНФЛ (14), номер карты. */
const DIGIT_RUN = /(?<!\p{Nd})\p{Nd}{7,}(?!\p{Nd})/gu;

/** Текст для модели: без невидимых знаков и соединителей, в форме NFKC, без адресов почты и телефонов. */
export function sanitizeForAi(text: string): string {
  return scanText(text)
    .replace(EMAIL, REDACTED.email)
    .replace(PHONE, (match) => (phoneLike(match, 7) ? REDACTED.phone : match))
    .replace(DIGIT_RUN, REDACTED.phone);
}

/** Замена известных слов (имена, название организации) меткой, без учёта регистра, только целым словом. stem: слово
 * с окончанием (основа "Ромашк" ловит "Ромашке", "ромашкой"; "Bahor" ловит "Bahorning"). */
export function redactTerms(text: string, terms: readonly { term: string; label: string; stem?: boolean }[]): string {
  let out = text;
  // Длинные первыми: "Иван Петров" раньше "Иван".
  for (const { term, label, stem } of [...terms].sort((a, b) => b.term.length - a.term.length)) {
    const clean = term.trim();
    if (clean.length < 2) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${stem ? '\\p{L}{0,6}' : ''}(?![\\p{L}\\p{N}])`, 'giu'), label);
  }
  return out;
}

/** Слова правовой формы: в названии организации они не значимы (ООО, MChJ, LLC и так далее). */
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'чп', 'мчж', 'хк', 'ук', 'mchj', 'xk', 'qk', 'aj', 'oaj', 'yatt', 'llc', 'ltd', 'inc', 'jsc', 'ojsc', 'corp', 'gmbh', 'co', 'ooo']);
/** Длина значимого слова названия. */
const ORG_WORD_MIN = 4;

/**
 * Значимые слова названия организации для вырезания по основе (повторная проверка M5, docs/decisions/0057): без
 * кавычек и слов правовой формы, от 4 знаков. У кириллического слова отбрасывается конечная гласная ("Ромашка" даёт
 * "Ромашк"), и основа ловит падежи; узбекские окончания прибавляются к слову целиком и ловятся без этого.
 */
export function orgNameTerms(name: string): string[] {
  const words = name.match(/[\p{L}\p{N}\u02BB\u02BC-]+/gu) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (word.length < ORG_WORD_MIN || LEGAL_FORMS.has(word.toLowerCase()) || !/\p{L}/u.test(word)) continue;
    const stem = /^[\p{Script=Cyrillic}-]+$/u.test(word) ? word.replace(/[аеёиоуыэюяьй]+$/iu, '') : word;
    const term = stem.length >= ORG_WORD_MIN ? stem : word;
    if (!out.some((t) => t.toLowerCase() === term.toLowerCase())) out.push(term);
  }
  return out;
}

/** Слова для вырезания названия организации: всё название целиком и его значимые слова по основе. */
export function orgRedactions(orgTerms: readonly string[], label: string): { term: string; label: string; stem?: boolean }[] {
  return orgTerms.flatMap((term) => [{ term, label }, ...orgNameTerms(term).map((word) => ({ term: word, label, stem: true }))]);
}

/** Угловые скобки текстом: данные не закрывают тег, в котором лежат. */
export function escapeData(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обрезка входа по пределу знаков (проверка на AI-инъекции, пункт 5). */
export function clip(text: string, max = AI_INPUT_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Модель из списка по идентификатору ответа: точное совпадение или та же модель с датой версии в конце. */
function knownModel(model: string): AiModel | null {
  return AI_MODELS.find((m) => model === m || model.startsWith(`${m}-`)) ?? null;
}

/**
 * Стоимость вызова в долларах по токенам и модели из ответа API (план M5b, решение 2), шесть знаков после запятой.
 * Неизвестная модель: цена самой дорогой из списка и предупреждение в журнал работы (без текста).
 */
export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const known = knownModel(model);
  if (!known) logEvent('warn', 'ai.unknown_model_price', { model: model.slice(0, 100) });
  const price = known
    ? AI_PRICE_PER_MTOK[known]
    : Object.values(AI_PRICE_PER_MTOK).reduce((max, p) => (p.input + p.output > max.input + max.output ? p : max));
  return Math.round(((usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000) * 1e6) / 1e6;
}

/**
 * HMAC очищенного входа модели (план M5b, решение 12) с ключом, выведенным из ENCRYPTION_KEY, как query_hash подсказки.
 * Регистр и пробелы не значимы. Текст по хешу не восстанавливается.
 */
export function inputHash(text: string, encryptionKeyBase64: string): string {
  const key = createHmac('sha256', Buffer.from(encryptionKeyBase64, 'base64')).update('hda:input').digest();
  return createHmac('sha256', key).update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
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
