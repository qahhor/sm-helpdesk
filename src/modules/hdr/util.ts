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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DOTTED_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * Праздники года вставкой списка (решение 25 вехи M4): даты ГГГГ-ММ-ДД или ДД.ММ.ГГГГ через строку, запятую или точку
 * с запятой; текст после даты (название праздника) пропускается. Дата другого года, несуществующая дата и не дата:
 * ошибка с номером строки, ничего не принимается. Повторы убираются, даты по порядку.
 */
export function parseHolidays(text: string, year: number): { ok: true; dates: string[] } | { ok: false; line: number } {
  const dates = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const part of line.split(/[,;]/)) {
      const item = part.trim();
      if (!item) continue;
      const token = item.split(/\s+/)[0] ?? '';
      const iso = ISO_DATE.exec(token);
      const dotted = DOTTED_DATE.exec(token);
      const date = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : null;
      const parsed = date === null ? Number.NaN : Date.parse(`${date}T00:00:00Z`);
      const real = date !== null && !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(date);
      if (!date || !real || !date.startsWith(`${year}-`)) return { ok: false, line: index + 1 };
      dates.add(date);
    }
  }
  return { ok: true, dates: [...dates].sort() };
}
