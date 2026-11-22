// Модуль hdr, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

const MARKER = /^(?:[-*•]\s+|\[[ xX]?\]\s*|\d{1,3}[.)]\s+)/;

/** Пункты памятки первой линии (FR-LINE-10): строки текста без маркеров списка и флажков, пустые пропущены. */
export function playbookItems(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(MARKER, '').trim())
    .filter((line) => line.length > 0);
}

/** Код шаблона после "/": латинские буквы, цифры и дефис, с буквы или цифры, до 40 знаков (FR-AG-06). */
export const SHORTCUT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Поиск по "/" нужен и полю ответа в браузере: общие функции лежат в src/lib/templates.ts.
export { filterTemplates, slashQuery } from '@/lib/templates';

/** Текст шаблона на языке обращения; перевода нет: русский и отметка для агента (FR-AG-06). */
export function renderTemplate(template: { body: Record<string, string | undefined> }, locale: string): { text: string; fallback: boolean } {
  const own = template.body[locale];
  if (own) return { text: own, fallback: false };
  return { text: template.body.ru ?? '', fallback: true };
}
