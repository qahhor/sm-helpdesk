// Модуль hdk, слой api: сигнатура ошибки из текста и контекста для других модулей (план M5c, задача 4: баннер
// известной проблемы). Чистая функция без базы: та же, что у подсказки и у записи сигнатуры обращения (ТЗ 11.5).

import { ticketErrorSignature } from '../signature';

/** Сигнатура: код и текст ошибки контекста виджета, иначе строка ошибки в описании. Нет ошибки: null. */
export function errorSignatureOf(input: { text: string; errorCode?: string | undefined; errorText?: string | undefined }): string | null {
  return ticketErrorSignature({ context: input.errorCode || input.errorText ? { errorCode: input.errorCode, errorText: input.errorText } : null, description: input.text })?.signature ?? null;
}
