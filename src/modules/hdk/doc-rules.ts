// Правила документа решения без зависимостей: закрытый список блоков, допустимые ссылки и адреса изображений.
// Их берут и схема документа (doc-schema.ts), и редактор в браузере: редактору не нужна библиотека Zod.

/** Виды блоков этапа 1 (план M5, задача 2). Этап 2 добавит video, codeBlock, details, articleLink, reusableBlock. */
export const BLOCK_TYPES = ['heading', 'paragraph', 'bulletList', 'orderedList', 'step', 'callout', 'table', 'image'] as const;
/** Отметки текста. Подчёркивание, зачёркивание, цвет и размер шрифта не входят: оформление задаёт портал. */
export const MARK_TYPES = ['bold', 'italic', 'code', 'link'] as const;
/** Заголовок первого уровня это заголовок решения, в теле только второй и третий. */
export const HEADING_LEVELS = [2, 3] as const;
export const CALLOUT_TONES = ['info', 'warning'] as const;
/** Узлы, которые несут устойчивый идентификатор. listItem, строки и ячейки таблицы это части блока. */
export const ID_NODE_TYPES = ['heading', 'paragraph', 'bulletList', 'orderedList', 'step', 'callout', 'table', 'image'] as const;
/** Предел блоков верхнего уровня (ТЗ 18.10; план M5, решение 13). */
export const MAX_BLOCKS = 400;
export const BLOCK_ID = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * Допустимая ссылка: https с именем узла, mailto с адресом или внутренний путь портала.
 * Протокол-относительные (//host), обратная косая черта и управляющие знаки отклоняются.
 */
export function isAllowedHref(href: string): boolean {
  if (href.length > 2000 || /[\s\\\u0000-\u001f\u007f]/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//');
  if (/^mailto:/i.test(href)) return /^mailto:[^@\s/]+@[^@\s/]+\.[^@\s/]+$/i.test(href);
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Адрес изображения: только внутренний путь портала. Файлы решения отдаёт портал после проверки прав (решение 16). */
export function isAllowedImageSrc(src: string): boolean {
  return src.length <= 500 && src.startsWith('/') && !src.startsWith('//') && !/[\s\\\u0000-\u001f\u007f]/.test(src);
}
