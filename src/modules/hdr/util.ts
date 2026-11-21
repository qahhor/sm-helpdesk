// Модуль hdr, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

const MARKER = /^(?:[-*•]\s+|\[[ xX]?\]\s*|\d{1,3}[.)]\s+)/;

/** Пункты памятки первой линии (FR-LINE-10): строки текста без маркеров списка и флажков, пустые пропущены. */
export function playbookItems(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(MARKER, '').trim())
    .filter((line) => line.length > 0);
}
