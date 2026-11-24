// Модуль hdw: текст шаблона макроса и черновик сотрудника (FR-AG-15, решение 7 плана M8; проверка вехи M8, находка
// I3). Чистый файл без базы. Макрос шаблон не отправляет: он дописывает его в черновик ответа, сотрудник читает и
// отправляет сам.

/** Черновик не длиннее сообщения (схема draftInput модуля обращений). */
export const MACRO_DRAFT_MAX = 20_000;

/**
 * Черновик с текстом шаблона. Черновика нет или он пуст: шаблон становится черновиком публичного ответа. Черновик
 * публичного ответа: шаблон дописывается после него. Непустой черновик внутренней заметки: null, шаблон не
 * вставляется. Иначе заметка для коллег склеилась бы с ответом клиенту и стала публичным черновиком: одно нажатие
 * "Отправить" показало бы её клиенту.
 */
export function draftWithTemplate(draft: { body: string; internal: boolean } | null, template: string): { body: string; internal: false } | null {
  const current = draft?.body ?? '';
  if (draft?.internal && current.trim() !== '') return null;
  const body = [current, template].filter((part) => part.trim() !== '').join('\n\n');
  return { body: body.slice(0, MACRO_DRAFT_MAX), internal: false };
}
