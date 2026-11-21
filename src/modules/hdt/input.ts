import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { HdtError } from './error';
import { IMPACTS, TICKET_STATUSES, TICKET_TYPES, VISIBILITIES } from './pref';

// Схемы входных данных модуля hdt. Каждая точка входа разбирает свой вход схемой (ТЗ 9.4, правило 7).

/** Пустая строка из формы считается отсутствием значения. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

/** Номер обращения числом или строкой из формы. */
export const numberInput = z.coerce.number().int().positive().max(999_999_999_999);

export const createTicketInput = z.object({
  description: z.string().trim().min(1).max(20000),
  title: optional(z.string().trim().min(1).max(200)),
  type: z.enum(TICKET_TYPES),
  impact: z.enum(IMPACTS),
  visibility: z.enum(VISIBILITIES).default('org'),
  moduleId: optional(z.uuid()),
  relatedNumber: optional(numberInput),
  // Предел в 10 файлов проверяет сервис своим кодом (too_many_files), схема отсекает только явный мусор.
  attachmentIds: z.array(z.uuid()).max(100).default([]),
  locale: z.enum(LOCALES),
});

export const listTicketsInput = z.object({
  scope: z.enum(['mine', 'org']).default('org'),
  status: optional(z.enum(TICKET_STATUSES)),
  type: optional(z.enum(TICKET_TYPES)),
  q: optional(z.string().trim().min(1).max(100)),
  cursor: optional(z.string().max(200)),
});

/** Разбирает вход схемой. Неверный вход превращается в ошибку модуля с кодом invalid_input. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HdtError('invalid_input');
  return result.data;
}
