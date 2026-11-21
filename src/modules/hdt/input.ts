import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';
import { HdtError } from './error';
import { CSAT_REASONS, IMPACTS, MAX_SNOOZE_DAYS, PRESENCE_MODES, PRIORITIES, RESOLUTION_TYPES, TICKET_STATUSES, TICKET_TYPES, VISIBILITIES } from './pref';
import { QUEUE_KEYS, QUEUE_SORTS } from './core/agent-queue-keys';

// Схемы входных данных модуля hdt. Каждая точка входа разбирает свой вход схемой (ТЗ 9.4, правило 7).

/** Пустая строка из формы считается отсутствием значения. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

/** Номер обращения числом или строкой из формы. */
export const numberInput = z.coerce.number().int().positive().max(999_999_999_999);

export const createTicketInput = z.object({
  description: z.string().overwrite(cleanUserText).trim().min(1).max(20000),
  title: optional(z.string().overwrite(cleanUserText).trim().min(1).max(200)),
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

const body = z.string().overwrite(cleanUserText).trim().min(1).max(20000);

export const replyInput = z.object({ number: numberInput, body, attachmentIds: z.array(z.uuid()).max(100).default([]) });

export const reopenInput = z.object({ number: numberInput, body: optional(body) });

/** Оценка 1..5, при 1-3 причина обязательна (FR-TK-11). */
export const rateInput = z
  .object({
    number: numberInput,
    score: z.coerce.number().int().min(1).max(5),
    reason: optional(z.enum(CSAT_REASONS)),
    comment: optional(z.string().overwrite(cleanUserText).trim().min(1).max(2000)),
  })
  .refine((value) => value.score > 3 || value.reason !== undefined);

export const visibilityInput = z.object({ number: numberInput, visibility: z.enum(VISIBILITIES) });

/**
 * Знаки, которых не должно быть в имени файла: путь, управляющие, разделители строк и невидимые форматирующие
 * (смена направления текста подменяет расширение для глаза: "photo\u202Egnp.txt" выглядит как "phototxt.png").
 * Соединители нулевой ширины U+200C и U+200D законны: из них состоят эмодзи и слова некоторых языков.
 */
const FILE_NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029/\\]|(?![\u200C\u200D])\p{Cf}/u;

/**
 * Запрос ссылки на загрузку. Имя файла без пути, управляющих и невидимых знаков. Пределы размера и тип проверяет
 * сервис своими кодами (file_too_large, file_not_allowed), схема отсекает только явный мусор.
 */
export const presignUploadInput = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !FILE_NAME_FORBIDDEN.test(name)),
  size: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  mime: optional(z.string().trim().max(127)),
});

export const attachmentIdInput = z.uuid();

/** Разбирает вход схемой. Неверный вход превращается в ошибку модуля с кодом invalid_input. */
// --- Рабочее место (план M3) ---

/** Очередь, сортировка и строка поиска рабочего места (FR-AG-01, FR-AG-10). */
export const queueInput = z.object({
  queue: z.enum(QUEUE_KEYS).default('new'),
  sort: z.enum(QUEUE_SORTS).default('sla'),
  q: optional(z.string().trim().min(1).max(200)),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const savedFilterInput = z.object({
  name: z.string().overwrite(cleanUserText).trim().min(1).max(80),
  query: z.object({ queue: z.enum(QUEUE_KEYS), sort: z.enum(QUEUE_SORTS).optional(), q: z.string().trim().max(200).optional() }),
  isShared: z.boolean().default(false),
});

export const assignInput = z.object({ number: numberInput, assigneeId: z.uuid().nullable() });

export const statusInput = z.object({
  number: numberInput,
  to: z.enum(TICKET_STATUSES),
  resolution: optional(z.enum(RESOLUTION_TYPES)),
  version: optional(z.string().overwrite(cleanUserText).trim().min(1).max(50)),
});

/** Причина обязательна (FR-SLA-03): пустую сервис отклоняет кодом reason_required, а не invalid_input. */
export const priorityInput = z.object({
  number: numberInput,
  priority: z.enum(PRIORITIES),
  reason: z.string().overwrite(cleanUserText).trim().max(500),
});

export const typeInput = z.object({ number: numberInput, type: z.enum(TICKET_TYPES) });
export const moduleInput = z.object({ number: numberInput, moduleId: z.uuid().nullable() });

export const snoozeInput = z.object({
  number: numberInput,
  until: z.coerce
    .date()
    .nullable()
    .refine((value) => value === null || (value.getTime() > Date.now() && value.getTime() < Date.now() + MAX_SNOOZE_DAYS * 86_400_000)),
});

/**
 * Ответ клиенту или внутренняя заметка (FR-AG-03). seenVersion: время последнего изменения, которое видел агент
 * (FR-AG-12). "Ждём ответа клиента" бывает только у ответа клиенту.
 */
export const staffMessageInput = z
  .object({
    number: numberInput,
    body,
    internal: z.boolean(),
    attachmentIds: z.array(z.uuid()).max(100).default([]),
    waitForClient: z.boolean().default(false),
    seenVersion: z.iso.datetime(),
  })
  .refine((data) => !(data.internal && data.waitForClient));

/** Черновик: пустой текст удаляет черновик. */
export const draftInput = z.object({ number: numberInput, body: z.string().overwrite(cleanUserText).trim().max(20000), internal: z.boolean() });

export const presenceInput = z.object({ number: numberInput, mode: z.enum(PRESENCE_MODES) });

/** Загрузка сотрудника: организация файла берётся из обращения, поэтому нужен его номер. */
export const staffPresignInput = presignUploadInput.extend({ number: numberInput });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HdtError('invalid_input');
  return result.data;
}
