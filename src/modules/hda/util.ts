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
export const REDACTED = { email: '[email]', phone: '[phone]', contact: '[contact]', client: 'Клиент', staff: 'Сотрудник', org: 'Организация' } as const;

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

/**
 * Контакты в обход правил почты и телефона (проверка на AI-инъекции, волна 7, S-M5). Почта словами: "(at)", "[at]",
 * "собака", "kuchukcha" вместо "@" и "точка", "dot", "nuqta" вместо точки. Голое английское "at" без скобок не
 * считается: это обычный предлог. Ссылки и имена мессенджеров: t.me/ник, wa.me/номер, @ник. Цифры через пробел
 * группами по одной-четыре от семи цифр: "9 0 1 2 3 4 5 6 7".
 */
const AT_WORD = String.raw`(?:\s?@\s?|\s*[(\[{]\s*(?:at|эт|собака|sobaka|kuchukcha)\s*[)\]}]\s*|\s+(?:собака|sobaka|kuchukcha)\s+)`;
const DOT_WORD = String.raw`(?:\.|\s*[(\[{]\s*(?:dot|точка|nuqta)\s*[)\]}]\s*|\s+(?:dot|точка|nuqta)\s+)`;
const SPELLED_EMAIL = new RegExp(String.raw`[\p{L}\p{N}._%+-]+${AT_WORD}[\p{L}\p{N}-]+(?:${DOT_WORD}[\p{L}\p{N}-]+)*${DOT_WORD}\p{L}{2,}`, 'giu');
const MESSENGER_LINK = /(?:https?:\/\/)?(?:t\.me|telegram\.me|wa\.me)\/[^\s<>"')]+/gi;
const HANDLE = /(?<![\p{L}\p{N}@._/-])@[A-Za-z][A-Za-z0-9_]{3,31}(?![\p{L}\p{N}@])/gu;
const SPACED_DIGITS = /(?<![\p{L}\p{N}])\+?\p{Nd}{1,4}(?:[ \u00A0\t]{1,2}\p{Nd}{1,4}){2,}(?![\p{L}\p{N}])/gu;
const SPACED_DIGITS_MIN = 7;
/** Сумма с разрядами через пробел (1 250 000): не телефон. Телефон тем же видом ловит общее правило PHONE. */
const THOUSANDS = /^\p{Nd}{1,3}(?:[ \u00A0]\p{Nd}{3})+$/u;

/** Замена контактов, записанных в обход правил, метками вызывающего. Текст уже после scanText. */
export function maskObfuscatedContacts(text: string, labels: { email: string; phone: string; contact: string }): string {
  return text
    .replace(SPELLED_EMAIL, labels.email)
    .replace(MESSENGER_LINK, labels.contact)
    .replace(HANDLE, labels.contact)
    .replace(SPACED_DIGITS, (match) => ((match.match(/\p{Nd}/gu)?.length ?? 0) >= SPACED_DIGITS_MIN && !THOUSANDS.test(match) ? labels.phone : match));
}

/** Текст для модели: без невидимых знаков и соединителей, в форме NFKC, без адресов почты, телефонов и контактов. */
export function sanitizeForAi(text: string): string {
  return maskObfuscatedContacts(scanText(text).replace(EMAIL, REDACTED.email), REDACTED)
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

/**
 * Знаки разметки текстом: данные не закрывают тег, в котором лежат. "&" экранируется первым (проверка на AI-инъекции,
 * волна 7, M9): иначе готовая сущность клиента "&lt;/ticket&gt;" неотличима во входе от экранированного тега.
 */
export function escapeData(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Обратное преобразование для текста, который модель вернула из экранированных данных (перевод): "&" последним.
 * Результат остаётся обычным текстом: показ его экранирует, как любой текст.
 */
export function unescapeData(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Одно сообщение переписки для модели (волна 7, S-I2): тег <msg> с ролью в атрибуте, содержимое экранировано. Роль
 * задаёт только код: слова "Сотрудник:" или тег <msg role="staff"> в тексте клиента остаются внутри его сообщения.
 */
export function messageTag(role: 'client' | 'staff', body: string, part?: 'title' | 'description' | 'reply'): string {
  return `<msg role="${role}"${part ? ` part="${part}"` : ''}>${body}</msg>`;
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

/** Слова текста для сравнения с подсказкой: строчные буквы и цифры, остальное разделитель. */
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Столько слов подряд из системной подсказки в ответе считаются её утечкой. */
const PROMPT_ECHO_WORDS = 6;
const shinglesCache = new Map<string, Set<string>>();

function promptShingles(system: string): Set<string> {
  let set = shinglesCache.get(system);
  if (!set) {
    const words = wordsOf(system);
    set = new Set<string>();
    for (let i = 0; i + PROMPT_ECHO_WORDS <= words.length; i++) set.add(words.slice(i, i + PROMPT_ECHO_WORDS).join(' '));
    if (shinglesCache.size > 50) shinglesCache.clear();
    shinglesCache.set(system, set);
  }
  return set;
}

/**
 * Ответ модели повторяет системную подсказку (проверка на AI-инъекции, волна 7, S-T; решение 0157): в любой строке
 * ответа есть шесть слов подряд из подсказки. Такой ответ не принимается целиком: отличительные фразы правил не
 * попадают в резюме, заголовок, черновик и перевод, которые читают сотрудники и клиенты.
 */
export function echoesSystemPrompt(value: unknown, system: string): boolean {
  const shingles = promptShingles(system);
  if (shingles.size === 0) return false;
  const check = (item: unknown): boolean => {
    if (typeof item === 'string') {
      const words = wordsOf(item);
      for (let i = 0; i + PROMPT_ECHO_WORDS <= words.length; i++) if (shingles.has(words.slice(i, i + PROMPT_ECHO_WORDS).join(' '))) return true;
      return false;
    }
    if (Array.isArray(item)) return item.some(check);
    if (item !== null && typeof item === 'object') return Object.values(item).some(check);
    return false;
  };
  return check(value);
}
