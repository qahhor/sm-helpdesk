import { createHash } from 'node:crypto';

// Модуль hdk: сигнатура ошибки (ТЗ 11.5, FR-SOL-07; план M5, задача 8, решение 7). Чистые функции без базы.
//
// normalizeErrorMessage и errorSignature повторяют раздел 11.5 дословно: сигнатура узнаёт ту же ошибку у другого
// клиента, даже если в тексте отличаются номера документов, даты, названия в кавычках и идентификаторы. Код и текст
// участвуют вместе: один код Oracle (например, пользовательский ORA-20001) означает разные ситуации.
//
// На портале кода и текста ошибки отдельными полями нет (их передаст виджет M6 контекстом), поэтому строка ошибки
// ищется в описании клиента: строка с кодом Oracle или строка с подписью "Ошибка:" на трёх языках. Шаблоны
// начальные и уточняются на корпусе реальных текстов Smartup (hub signatures:test, tests/fixtures/errors/).
// Без строки ошибки сигнатуры нет: подсказка ищет по словам и смыслу.

export function normalizeErrorMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/["'«»“”][^"'«»“”]{1,80}["'«»“”]/g, '<s>') // значения в кавычках
    .replace(/\d+([.,]\d+)?/g, '<n>') // числа, суммы, номера
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function errorSignature(ctx?: { errorCode?: string; errorMessage?: string; moduleCode?: string }): string | null {
  const code = ctx?.errorCode?.trim().toUpperCase() ?? '';
  const msg = ctx?.errorMessage ? normalizeErrorMessage(ctx.errorMessage) : '';
  if (!code && !msg) return null;
  return createHash('sha256')
    .update([code, msg, ctx?.moduleCode ?? ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Приставки кодов ошибок, которые считаются кодом Smartup: Oracle (ORA), PL/SQL (PLS), сеть Oracle (TNS). Номер
 * обращения SUP-1234 и прочие похожие на код слова кодом не считаются. Список уточняется на корпусе.
 */
export const ERROR_CODE_PREFIXES = ['ORA', 'PLS', 'TNS'] as const;
/** Строки стека вызовов Oracle: место ошибки, а не сама ошибка. */
const STACK_CODES = new Set(['ORA-06512']);
const CODE = new RegExp(`(?<![\\p{L}\\p{N}])((?:${ERROR_CODE_PREFIXES.join('|')})-\\d{4,5})(?![\\p{N}])`, 'iu');
/** Подпись перед текстом ошибки: русский, английский, узбекский в латинице и кириллице. */
const LABEL = /^\s*(?:текст ошибки|ошибка|error|xato|хато)\s*:\s*(.+)$/iu;
/** Текст ошибки с подписью, но без кода: не меньше двух слов, иначе это не текст ошибки ("Ошибка: да"). */
const MIN_LABEL_WORDS = 2;
/** Сколько знаков текста ошибки берётся из описания. */
const MESSAGE_MAX = 500;

export type ErrorLine = { code: string; message: string };

/** Строка ошибки Smartup в свободном тексте: первая строка с кодом (кроме строк стека), иначе строка с подписью. */
export function findErrorLine(text: string): ErrorLine | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const match = CODE.exec(line);
    if (!match) continue;
    const code = (match[1] as string).toUpperCase();
    if (STACK_CODES.has(code)) continue;
    let message = line.slice((match.index ?? 0) + match[0].length).replace(/^[\s:.-]+/u, '').trim();
    // Код в конце строки ("выходит ошибка ORA-01403"): текст ошибки на следующей непустой строке.
    if (!message) message = (lines.slice(i + 1).find((next) => next.trim() !== '' && !CODE.test(next)) ?? '').trim();
    return { code, message: message.slice(0, MESSAGE_MAX) };
  }
  for (const line of lines) {
    const match = LABEL.exec(line);
    if (!match) continue;
    const message = (match[1] as string).trim();
    if ((message.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) < MIN_LABEL_WORDS) continue;
    return { code: '', message: message.slice(0, MESSAGE_MAX) };
  }
  return null;
}

/**
 * Сигнатура из текста (описание обращения, запрос подсказки). Модуль в сигнатуру с портала не входит: модуль,
 * выбранный клиентом в форме, ненадёжен и меняется по ходу ввода, а подсказка и созданное обращение должны дать
 * одну сигнатуру. Модуль экрана придёт контекстом из виджета (решение 0055).
 */
export function signatureFromText(text: string): string | null {
  const line = findErrorLine(text);
  return line ? errorSignature({ errorCode: line.code, errorMessage: line.message }) : null;
}

/**
 * Сигнатура и её составные части. message: нормализованный текст (числа, кавычки, идентификаторы уже заменены);
 * raw: текст ошибки как есть, из него пример для сотрудников строится после очистки от данных клиента.
 */
export type TicketSignature = { signature: string; code: string; message: string; raw: string };

function fromLine(line: ErrorLine | null): TicketSignature | null {
  if (!line) return null;
  const signature = errorSignature({ errorCode: line.code, errorMessage: line.message });
  if (!signature) return null;
  return { signature, code: line.code.trim().toUpperCase(), message: normalizeErrorMessage(line.message), raw: line.message };
}

/** Сигнатура обращения (решение 7): код и текст ошибки из контекста, если они есть, иначе строка ошибки в описании. */
export function ticketErrorSignature(input: { context?: { errorCode?: string; errorText?: string } | null; description: string }): TicketSignature | null {
  const ctx = input.context;
  return fromLine(ctx && (ctx.errorCode?.trim() || ctx.errorText?.trim()) ? { code: ctx.errorCode ?? '', message: ctx.errorText ?? '' } : findErrorLine(input.description));
}

/**
 * Сигнатура, которую сотрудник привязывает к решению в редакторе: код и текст ошибки. Без кода текст разбирается
 * как описание клиента (строка "ORA-20001: ..." даст ту же сигнатуру, что у обращения), иначе берётся целиком.
 */
export function staffErrorSignature(input: { code?: string; text: string }): TicketSignature | null {
  if (input.code?.trim()) return fromLine({ code: input.code, message: input.text });
  return fromLine(findErrorLine(input.text) ?? { code: '', message: input.text });
}

// --- Корпус для подстройки (hub signatures:test) ---

export type CorpusEntry = { label: string | null; text: string };
export type CorpusGroup = { signature: string; code: string; message: string; labels: string[]; texts: CorpusEntry[] };
export type CorpusReport = {
  total: number;
  groups: CorpusGroup[];
  unrecognized: CorpusEntry[];
  /** Метки, тексты которых попали в разные сигнатуры: одна ошибка распалась. */
  splitLabels: string[];
  /** Сигнатуры, в которые попали тексты разных меток: разные ошибки слились. */
  mixedGroups: string[];
};

/** Файл корпуса: записи через пустую строку, строки с # пропускаются, метка ожидаемой группы в начале: [метка]. */
export function parseCorpus(content: string): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const block of content.split(/\r?\n[ \t]*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .trim();
    if (!text) continue;
    const label = /^\[([^\]\n]{1,60})\]\s*/u.exec(text);
    entries.push(label ? { label: (label[1] as string).trim(), text: text.slice(label[0].length) } : { label: null, text });
  }
  return entries;
}

/** Группы "сигнатура -> тексты" и сводка по меткам. Группы по убыванию размера. */
export function groupCorpus(entries: readonly CorpusEntry[]): CorpusReport {
  const groups = new Map<string, CorpusGroup>();
  const unrecognized: CorpusEntry[] = [];
  for (const entry of entries) {
    const found = ticketErrorSignature({ description: entry.text });
    if (!found) {
      unrecognized.push(entry);
      continue;
    }
    const group = groups.get(found.signature) ?? { signature: found.signature, code: found.code, message: found.message, labels: [], texts: [] };
    group.texts.push(entry);
    if (entry.label && !group.labels.includes(entry.label)) group.labels.push(entry.label);
    groups.set(found.signature, group);
  }
  const list = [...groups.values()].sort((a, b) => b.texts.length - a.texts.length || a.signature.localeCompare(b.signature));
  for (const group of list) group.labels.sort();
  const labelGroups = new Map<string, number>();
  for (const group of list) for (const label of group.labels) labelGroups.set(label, (labelGroups.get(label) ?? 0) + 1);
  return {
    total: entries.length,
    groups: list,
    unrecognized,
    splitLabels: [...labelGroups].filter(([, count]) => count > 1).map(([label]) => label).sort(),
    mixedGroups: list.filter((group) => group.labels.length > 1).map((group) => group.signature),
  };
}
