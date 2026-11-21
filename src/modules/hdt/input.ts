import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { HdtError } from './error';
import { CSAT_REASONS, IMPACTS, TICKET_STATUSES, TICKET_TYPES, VISIBILITIES } from './pref';

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

const body = z.string().trim().min(1).max(20000);

export const replyInput = z.object({ number: numberInput, body, attachmentIds: z.array(z.uuid()).max(100).default([]) });

export const reopenInput = z.object({ number: numberInput, body: optional(body) });

/** Оценка 1..5, при 1-3 причина обязательна (FR-TK-11). */
export const rateInput = z
  .object({
    number: numberInput,
    score: z.coerce.number().int().min(1).max(5),
    reason: optional(z.enum(CSAT_REASONS)),
    comment: optional(z.string().trim().min(1).max(2000)),
  })
  .refine((value) => value.score > 3 || value.reason !== undefined);

export const visibilityInput = z.object({ number: numberInput, visibility: z.enum(VISIBILITIES) });

/**
 * Запрос ссылки на загрузку. Имя файла без пути и управляющих знаков. Пределы размера и тип проверяет сервис
 * своими кодами (file_too_large, file_not_allowed), схема отсекает только явный мусор.
 */
export const presignUploadInput = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\p{Cc}/\\]/u.test(name)),
  size: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  mime: optional(z.string().trim().max(127)),
});

export const attachmentIdInput = z.uuid();

/** Разбирает вход схемой. Неверный вход превращается в ошибку модуля с кодом invalid_input. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HdtError('invalid_input');
  return result.data;
}
