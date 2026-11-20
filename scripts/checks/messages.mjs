// Проверки файлов сообщений messages/<язык>.json:
// - полнота: в каждом языке те же ключи, что в русском (FR-I18N-04);
// - ICU: строка разбирается, подстановки те же, что в русском;
// - слова: правила голоса и словаря (ТЗ, раздел 8.13), см. docs/decisions/0005-message-namespaces.md.
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const REFERENCE = 'ru';

/** @typedef {{ locale: string; key: string; problem: string }} Problem */
/** @typedef {{ [key: string]: string | Tree }} Tree */

/**
 * Плоский список: ключи через точку.
 * @param {Tree} tree
 * @param {string} [prefix]
 * @returns {Map<string, string>}
 */
export function flatten(tree, prefix = '') {
  /** @type {Map<string, string>} */
  const flat = new Map();
  for (const [key, value] of Object.entries(tree ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') for (const [k, v] of flatten(value, path)) flat.set(k, v);
    else flat.set(path, String(value));
  }
  return flat;
}

/**
 * @param {Record<string, Tree>} sources сообщения по языкам
 * @returns {Problem[]}
 */
export function checkCompleteness(sources) {
  /** @type {Problem[]} */
  const problems = [];
  const reference = flatten(sources[REFERENCE] ?? {});
  for (const [locale, tree] of Object.entries(sources)) {
    const flat = flatten(tree);
    for (const [key, value] of flat) if (value.trim() === '') problems.push({ locale, key, problem: 'empty' });
    if (locale === REFERENCE) continue;
    for (const key of reference.keys()) if (!flat.has(key)) problems.push({ locale, key, problem: 'missing' });
    for (const key of flat.keys()) if (!reference.has(key)) problems.push({ locale, key, problem: 'extra' });
  }
  return problems;
}

/**
 * Имена подстановок строки ICU. Бросает ошибку, если строка не разбирается.
 * @param {string} message
 * @returns {Set<string>}
 */
function icuArguments(message) {
  /** @type {Set<string>} */
  const names = new Set();
  const walk = (/** @type {import('@formatjs/icu-messageformat-parser').MessageFormatElement[]} */ elements) => {
    for (const element of elements) {
      if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
      names.add(element.value);
      if (element.type === TYPE.plural || element.type === TYPE.select)
        for (const option of Object.values(element.options)) walk(option.value);
      if (element.type === TYPE.tag) walk(element.children);
    }
  };
  walk(parse(message));
  return names;
}

/**
 * @param {Record<string, Tree>} sources
 * @returns {Problem[]}
 */
export function checkIcu(sources) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Map<string, Set<string>>} */
  const referenceArguments = new Map();
  const order = [REFERENCE, ...Object.keys(sources).filter((locale) => locale !== REFERENCE)];
  for (const locale of order) {
    for (const [key, value] of flatten(sources[locale] ?? {})) {
      let names;
      try {
        names = icuArguments(value);
      } catch {
        problems.push({ locale, key, problem: 'icu-syntax' });
        continue;
      }
      if (locale === REFERENCE) referenceArguments.set(key, names);
      else
        for (const name of referenceArguments.get(key) ?? [])
          if (!names.has(name)) problems.push({ locale, key, problem: `missing-argument:${name}` });
    }
  }
  return problems;
}

// Запрещённые слова. prefix: начало слова в любой форме ("тикет" ловит "тикетов").
// whole: только слово целиком ("точно" не ловит "точность").
/** @typedef {{ word: string; mode: 'prefix' | 'whole' | 'text' }} WordRule */
const prefix = (/** @type {string[]} */ ...words) => words.map((word) => /** @type {WordRule} */ ({ word, mode: 'prefix' }));
const whole = (/** @type {string[]} */ ...words) => words.map((word) => /** @type {WordRule} */ ({ word, mode: 'whole' }));

/** Для всех языков и пространств имён. */
const EVERYWHERE = [/** @type {WordRule} */ ({ word: 'Smartup ERP', mode: 'text' })];

/** По языкам, для всех пространств имён. */
/** @type {Record<string, WordRule[]>} */
const BY_LOCALE = {
  ru: [...prefix('тикет', 'заявк', 'кейс', 'инцидент', 'фич', 'гарантированн'), ...whole('FAQ', 'L1', 'L2', 'точно')],
  uz: [...prefix('dala', 'дала')],
};

/** По языкам, только для текстов клиента (пространства common и client). */
/** @type {Record<string, WordRule[]>} */
const CLIENT_ONLY = {
  ru: [...whole('SLA'), ...prefix('эскалац', 'очеред')],
  en: [...whole('SLA'), ...prefix('ticket', 'escalat', 'queue')],
  uz: [...whole('SLA'), ...prefix('tiket', 'eskalatsiya')],
};
const CLIENT_NAMESPACES = new Set(['common', 'client']);

const LETTER = '[\\p{L}\\p{N}_]';
const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {WordRule} rule */
function toRegExp(rule) {
  const word = escape(rule.word);
  if (rule.mode === 'text') return new RegExp(word, 'iu');
  const end = rule.mode === 'whole' ? `(?!${LETTER})` : '';
  return new RegExp(`(?<!${LETTER})${word}${end}`, 'iu');
}

/** Имя правила в сообщении: слово "фич" показывается как запрещённое слово "фича". */
const DISPLAY = { фич: 'фича' };

/**
 * @param {Record<string, Tree>} sources
 * @returns {Problem[]}
 */
export function checkWords(sources) {
  /** @type {Problem[]} */
  const problems = [];
  for (const [locale, tree] of Object.entries(sources)) {
    for (const [key, value] of flatten(tree)) {
      const namespace = key.split('.')[0];
      const rules = [
        ...EVERYWHERE,
        ...(BY_LOCALE[locale] ?? []),
        ...(CLIENT_NAMESPACES.has(namespace) ? (CLIENT_ONLY[locale] ?? []) : []),
      ];
      for (const rule of rules)
        if (toRegExp(rule).test(value))
          problems.push({ locale, key, problem: `forbidden:${DISPLAY[rule.word] ?? rule.word}` });
      if (value.includes('\u2014')) problems.push({ locale, key, problem: 'forbidden:U+2014' });
      if (value.includes('\u2013')) problems.push({ locale, key, problem: 'forbidden:U+2013' });
    }
  }
  return problems;
}
