import 'server-only';
// Модуль hdk, слой api: сигнатура ошибки из текста и контекста для других модулей (план M5c, задача 4: баннер
// известной проблемы; веха M8c, задача 5: точные сигнатуры по утверждённым шаблонам знаний из кода).
//
// Сначала утверждённые шаблоны каталога ошибок (FR-CODE-04): строка ошибки или строка описания совпала с шаблоном,
// сигнатурой становится сигнатура ключа записи. Иначе прежний способ 11.5. Одна функция для обращения, подсказки на
// портале и в виджете, баннера проблемы и привязки сотрудником: один текст даёт одну сигнатуру.

import { codeTemplateSignature } from '@/modules/hda/api/code-match';
import { findErrorLine, normalizeErrorMessage, staffErrorSignature, type TicketSignature, templateCandidateLines, ticketErrorSignature } from '../signature';

type SignatureInput = { text: string; errorCode?: string | null | undefined; errorText?: string | null | undefined };

/** Сигнатура из утверждённых шаблонов: та же форма, что у 11.5, чтобы запись встречи и пример работали одинаково. */
async function fromTemplates(input: { code: string | null; errorText: string | null; description: string }): Promise<TicketSignature | null> {
  const lines = templateCandidateLines({ errorText: input.errorText, description: input.description });
  const signature = await codeTemplateSignature({ code: input.code, lines });
  if (!signature) return null;
  const raw = input.errorText?.trim() || findErrorLine(input.description)?.message || lines[0] || '';
  return { signature, code: (input.code ?? '').trim().toUpperCase(), message: normalizeErrorMessage(raw), raw };
}

/** Сигнатура обращения, подсказки и баннера: шаблоны знаний из кода, затем 11.5. Нет ошибки: null. */
export async function resolveErrorSignature(input: SignatureInput): Promise<TicketSignature | null> {
  const context = input.errorCode?.trim() || input.errorText?.trim() ? { errorCode: input.errorCode ?? '', errorText: input.errorText ?? '' } : null;
  const line = context ? null : findErrorLine(input.text);
  const code = context ? context.errorCode || null : line?.code || null;
  const byTemplate = await fromTemplates({ code, errorText: context?.errorText || null, description: input.text });
  return byTemplate ?? ticketErrorSignature({ context, description: input.text });
}

/** Сигнатура, которую сотрудник привязывает к решению: шаблоны знаний из кода, затем правило staffErrorSignature. */
export async function resolveStaffSignature(input: { code?: string; text: string }): Promise<TicketSignature | null> {
  const code = input.code?.trim() || findErrorLine(input.text)?.code || null;
  const byTemplate = await fromTemplates({ code, errorText: input.code?.trim() ? input.text : null, description: input.text });
  return byTemplate ?? staffErrorSignature(input);
}

/** Сигнатура строкой: код и текст ошибки контекста виджета, иначе строка ошибки в описании. Нет ошибки: null. */
export async function errorSignatureOf(input: { text: string; errorCode?: string | undefined; errorText?: string | undefined }): Promise<string | null> {
  return (await resolveErrorSignature(input))?.signature ?? null;
}

/** Строки для шаблонов знаний из кода: для блока "Что известно по коду" модуля hda (веха M8c). */
export { templateCandidateLines } from '../signature';
