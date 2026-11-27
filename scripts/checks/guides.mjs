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

// --- Черновики юридических текстов docs/legal (план M9, задача 11, решение 19) ---

export const LEGAL_FILES = ['privacy-draft', 'ai-consent-draft'].flatMap((kind) => ['ru', 'uz', 'en'].map((locale) => `docs/legal/${kind}.${locale}.md`));
const LEGAL_MARK = /^> Черновик для юриста/;
/** Субобработчики раздела 14.6 ТЗ версии 1.2 (Hermes Agent обрабатывает обезличенные тексты, решение ТЗ 79). */
export const SUBPROCESSORS = ['Hetzner', 'Cloudflare', 'Resend', 'Telegram', 'Anthropic', 'OpenAI', 'Hermes Agent'];
const SUBPROCESSOR_HEADINGS = /^## (Кому передаются данные|Ma'lumotlar kimga uzatiladi|Who receives the data)\s*$/m;

/** @param {string} text @returns {string[] | null} имена субобработчиков из пунктов раздела, null без раздела */
function subprocessorsOf(text) {
  const start = text.search(SUBPROCESSOR_HEADINGS);
  if (start < 0) return null;
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const lines = end < 0 ? rest : rest.slice(0, end);
  return lines
    .filter((line) => line.startsWith('- ') && line.includes(':'))
    .flatMap((line) => line.slice(2, line.indexOf(':')).split(/\s+(?:и|va|and|через|orqali|via)\s+|,\s*/))
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * @param {string} path путь черновика docs/legal/<вид>.<язык>.md
 * @param {string} text
 * @returns {string[]}
 */
export function legalProblems(path, text) {
  const locale = /\.(ru|uz|en)\.md$/.exec(path)?.[1] ?? 'ru';
  /** @type {string[]} */
  const problems = [];
  if (!LEGAL_MARK.test(text.split('\n')[0] ?? '')) problems.push(`${path}:1 нет пометки "Черновик для юриста" в первой строке`);
  if (path.includes('privacy-draft')) {
    const names = subprocessorsOf(text);
    if (names === null) problems.push(`${path}: нет раздела о субобработчиках`);
    else {
      for (const name of names) if (!SUBPROCESSORS.includes(name)) problems.push(`${path}: субобработчик ${name} не назван в разделе 14.6 ТЗ`);
      for (const name of SUBPROCESSORS) if (!names.includes(name)) problems.push(`${path}: нет субобработчика ${name} из раздела 14.6 ТЗ`);
    }
  }
  text.split('\n').forEach((line, index) => {
    // Строки ">" для юриста в портал не переносятся: в них можно назвать запрещённое слово, если его обсуждают.
    if (line.startsWith('>')) return;
    for (const word of forbiddenWordsIn(locale, line, true, PROMISES[locale] ?? [])) problems.push(`${path}:${index + 1} запрещённое слово ${word}`);
  });
  return problems;
}

/** @returns {string[]} нарушения настоящих инструкций и черновиков юридических текстов */
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
  }).concat(
    LEGAL_FILES.flatMap((path) => {
      let text;
      try {
        text = readFileSync(resolve(root, path), 'utf8');
      } catch {
        return [`${path}: файла нет`];
      }
      return legalProblems(path, text);
    }),
  );
}
