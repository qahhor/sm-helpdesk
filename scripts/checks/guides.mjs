// Инструкции сотрудника и клиента docs/guides (план подготовки M9, задача 7, решения 10 и 11). Названия кнопок и
// разделов пишутся в «...» и должны быть в messages/<язык>.json тем же текстом: инструкция не называет того, чего нет
// в интерфейсе. Слова, запрещённые разделом 8.13 ТЗ, и обещания проверяются как в текстах интерфейса ("точно",
// "гарантированно" и их английский и узбекский смысл). Узбекская инструкция до вычитки носителем помечена "Qoralama".
// Длинное и среднее тире ловит общая проверка dashes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flatten, forbiddenWordsIn, prefixRule } from './messages.mjs';

const root = resolve(import.meta.dirname, '../..');

export const GUIDE_FILES = ['client', 'staff'].flatMap((kind) => ['ru', 'uz', 'en'].map((locale) => `docs/guides/${kind}.${locale}.md`));

/** Обещания сверх общих правил: для инструкций всех языков. */
const PROMISES = { en: prefixRule('guarantee'), uz: prefixRule('kafolat') };
const DRAFT_MARK = /^> \*\*Qoralama\.?\*\*/m;

/** @param {string} text @returns {string[]} названия в «...» */
export function quotedLabels(text) {
  return [...text.matchAll(/«([^«»\n]+)»/g)].map((m) => m[1].trim());
}

/**
 * @param {string} path путь инструкции: docs/guides/<client|staff>.<язык>.md
 * @param {string} text
 * @param {Record<string, unknown>} messages деревья messages/<язык>.json по языкам
 * @returns {string[]}
 */
export function guideProblems(path, text, messages) {
  const match = /(client|staff)\.(ru|uz|en)\.md$/.exec(path);
  if (!match) return [`${path} не инструкция: ожидается docs/guides/<client|staff>.<ru|uz|en>.md`];
  const [, kind, locale] = match;
  const values = new Set([...flatten(messages[locale] ?? {})].map(([, value]) => String(value).trim()));
  /** @type {string[]} */
  const problems = [];
  if (locale === 'uz' && !DRAFT_MARK.test(text)) problems.push(`${path}:1 нет пометки "Qoralama" (черновик до вычитки носителем языка, решение 11)`);
  text.split('\n').forEach((line, index) => {
    for (const label of quotedLabels(line)) if (!values.has(label)) problems.push(`${path}:${index + 1} «${label}» нет в messages/${locale}.json`);
    for (const word of forbiddenWordsIn(locale, line, kind === 'client', PROMISES[locale] ?? [])) problems.push(`${path}:${index + 1} запрещённое слово ${word}`);
  });
  return problems;
}

/** @returns {string[]} нарушения настоящих инструкций */
export function guidesCheck() {
  const messages = Object.fromEntries(['ru', 'uz', 'en'].map((locale) => [locale, JSON.parse(readFileSync(resolve(root, `messages/${locale}.json`), 'utf8'))]));
  return GUIDE_FILES.flatMap((path) => {
    let text;
    try {
      text = readFileSync(resolve(root, path), 'utf8');
    } catch {
      return [`${path}: файла нет`];
    }
    return guideProblems(path, text, messages);
  });
}
