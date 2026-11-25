import { createHash } from 'node:crypto';

// Модуль hdi, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

/** SHA-256 заголовка и описания: отпечаток текста оригинала для переводов и журнала (без самого текста). */
export function textHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

/** Идея принята по номеру: "I-204" или "204". */
export function parseIdeaNumber(value: string): number | null {
  const match = /^(?:I-)?(\d{1,10})$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Число слов в тексте: форма спрашивает похожие идеи после трёх слов (решение 23). */
export function wordCount(text: string): number {
  return text.split(/[\s\p{P}]+/u).filter((word) => word.length > 0).length;
}
