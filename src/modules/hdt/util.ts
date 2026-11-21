// Модуль hdt, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

const TITLE_MAX = 80;

/**
 * Тема обращения из описания (FR-TK-02): первая строка, из неё первое предложение без конечного знака,
 * не длиннее 80 знаков с обрезкой по границе слова. Клиент может поправить тему.
 */
export function titleFromDescription(description: string): string {
  const firstLine = description.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const sentence = (/^(.*?[^.!?])[.!?]+(\s|$)/u.exec(firstLine)?.[1] ?? firstLine).trim();
  const chars = Array.from(sentence);
  if (chars.length <= TITLE_MAX) return sentence;
  const cut = chars.slice(0, TITLE_MAX).join('');
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space).trimEnd() : cut;
}

/** Номер для людей: SUP-1042 (FR-TK-05). */
export const formatNumber = (number: number): string => `SUP-${number}`;

/** Номер из SUP-1042, sup-1042 или 1042. Иначе пусто. */
export function parseNumber(raw: string): number | null {
  const match = /^\s*(?:sup-)?(\d{1,12})\s*$/i.exec(raw);
  return match ? Number(match[1]) : null;
}
