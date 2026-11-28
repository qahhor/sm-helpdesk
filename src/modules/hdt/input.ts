import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';
import { HdtError } from './error';
import { CSAT_REASONS, IMPACTS, INTAKE_CHANNELS, MAX_SNOOZE_DAYS, PRESENCE_MODES, PRIORITIES, RESOLUTION_TYPES, TICKET_STATUSES, TICKET_TYPES, TRANSFER_REASONS, VISIBILITIES } from './pref';
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
  // Форма открыта из загрузчика виджета (режим B, решение 12): только показатели, на права не влияет.
  widget: optional(z.literal('1')),
  // Подсказки режима B строкой JSON, разбираются modeBContext. Без признака виджета не используются.
  context: optional(z.string().max(4096)),
});

/** Строка подсказки виджета (решение 11 плана M6): код модуля и экрана из букв, цифр и знаков _.:- до 64 знаков. */
const HINT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const hintText = (max: number) => optional(z.string().overwrite(cleanUserText).trim().min(1).max(max));

/**
 * Контекст обращения из подсказок виджета (план M6, решения 10 и 11). Подсказки не подписаны: они идут только в поля
 * контекста, сигнатуру и предзаполнение и никогда не влияют на права. Платформу берёт сервер из токена, а не отсюда.
 */
export const widgetContextInput = z.strictObject({
  moduleCode: optional(z.string().regex(HINT_CODE)),
  screen: optional(z.string().regex(HINT_CODE)),
  version: hintText(32),
  errorCode: hintText(64),
  errorText: hintText(2000),
});

/**
 * Контекст режима B (план M6, задача 8; решение 11): форма портала присылает подсказки загрузчика строкой JSON. Каждое
 * поле проверяется отдельно, неверное отбрасывается, остальные остаются; испорченная строка даёт пустой контекст.
 */
export function modeBContext(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.length > 4096) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const context: Record<string, string> = {};
  for (const [key, schema] of Object.entries(widgetContextInput.shape)) {
    const parsed = schema.safeParse(source[key]);
    if (parsed.success && typeof parsed.data === 'string') context[key] = parsed.data;
  }
  return context;
}

/**
 * Обращение из виджета (план M6, задача 5): описание "Что вы делали перед ошибкой?", необязательные модуль, тип и
 * влияние (по умолчанию ошибка, серьёзно мешает), файлы, контекст. Поля организации и автора не принимаются:
 * лишний ключ отклоняет схему. Тема строится из описания, как на портале.
 */
export const widgetTicketInput = z.strictObject({
  description: z.string().overwrite(cleanUserText).trim().min(1).max(20000),
  type: z.enum(TICKET_TYPES).default('bug'),
  impact: z.enum(IMPACTS).default('major'),
  visibility: z.enum(VISIBILITIES).default('org'),
  moduleId: optional(z.uuid()),
  attachmentIds: z.array(z.uuid()).max(100).default([]),
  locale: z.enum(LOCALES),
  context: widgetContextInput.default({}),
  suggestSession: optional(z.uuid()),
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
  // Тег из справочника (FR-AUTO-13): в очереди остаются обращения с этим тегом.
  tag: optional(z.uuid()),
  // Ключ последней строки прошлой страницы: время изменения с микросекундами и идентификатор обращения.
  after: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).refine((value) => !Number.isNaN(Date.parse(value.slice(0, 23) + 'Z')))),
});

export const savedFilterInput = z.object({
  name: z.string().overwrite(cleanUserText).trim().min(1).max(80),
  // Текст поиска хранится в jsonb: невидимые и управляющие знаки убираются, как у названия (волна 7, S-T).
  query: z.object({ queue: z.enum(QUEUE_KEYS), sort: z.enum(QUEUE_SORTS).optional(), q: z.string().overwrite(cleanUserText).trim().max(200).optional() }),
  isShared: z.boolean().default(false),
});

/** seenVersion: версия обращения, которую видел сотрудник на странице (FR-AG-12). Не передана: проверки нет. */
const seenVersion = optional(z.iso.datetime());

export const assignInput = z.object({ number: numberInput, assigneeId: z.uuid().nullable(), seenVersion });

export const statusInput = z.object({
  number: numberInput,
  to: z.enum(TICKET_STATUSES),
  resolution: optional(z.enum(RESOLUTION_TYPES)),
  version: optional(z.string().overwrite(cleanUserText).trim().min(1).max(50)),
  seenVersion,
});

/** Причина обязательна (FR-SLA-03): пустую сервис отклоняет кодом reason_required, а не invalid_input. */
export const priorityInput = z.object({
  number: numberInput,
  priority: z.enum(PRIORITIES),
  reason: z.string().overwrite(cleanUserText).trim().max(500),
  seenVersion,
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
export const staffPresignInput = z.union([presignUploadInput.extend({ number: numberInput }), presignUploadInput.extend({ orgId: z.uuid() })]);

/** Передача на вторую линию (FR-LINE-03): причина из списка, что проверено, что требуется. Пункты памятки по желанию. */
export const transferInput = z.object({
  number: numberInput,
  reason: z.enum(TRANSFER_REASONS),
  checked: z.string().overwrite(cleanUserText).trim().min(1).max(2000),
  needed: z.string().overwrite(cleanUserText).trim().min(1).max(2000),
  checklist: z.array(z.string().overwrite(cleanUserText).trim().min(1).max(300)).max(50).default([]),
});

/** Возврат на первую линию (FR-LINE-04): пояснение обязательно. */
export const returnInput = z.object({ number: numberInput, explanation: z.string().overwrite(cleanUserText).trim().min(1).max(2000) });

/** Объединить дубль с основным (FR-AG-07). */
export const mergeInput = z.object({ number: numberInput, intoNumber: numberInput });

/** Массовые действия в списке (FR-AG-20): до 100 обращений; на вторую линию только с запиской, на первую с пояснением. */
const bulkNumbers = z.array(numberInput).min(1).max(100);
export const bulkInput = z.union([
  z.object({ action: z.literal('assign'), numbers: bulkNumbers, assigneeId: z.uuid().nullable() }),
  z.object({ action: z.literal('duplicate'), numbers: bulkNumbers, intoNumber: numberInput }),
  z.object({
    action: z.literal('queue'),
    numbers: bulkNumbers,
    to: z.literal('l2'),
    reason: z.enum(TRANSFER_REASONS),
    checked: z.string().overwrite(cleanUserText).trim().min(1).max(2000),
    needed: z.string().overwrite(cleanUserText).trim().min(1).max(2000),
  }),
  z.object({ action: z.literal('queue'), numbers: bulkNumbers, to: z.literal('l1'), explanation: z.string().overwrite(cleanUserText).trim().min(1).max(2000) }),
]);

/** Обращение от имени клиента (FR-AG-08): организация и участник выбраны сотрудником, остальное как у клиента. */
export const staffCreateInput = createTicketInput.omit({ relatedNumber: true, widget: true, context: true }).extend({
  orgId: z.uuid(),
  authorId: z.uuid(),
  priority: optional(z.enum(PRIORITIES)),
  // Откуда пришло мимо портала: обязательно (план M9, решение 12).
  intakeChannel: z.enum(INTAKE_CHANNELS),
});

/** Страница списка благодарностей. */
export const thanksInput = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });

/** Следующее обращение очереди (FR-AG-17). */
export const nextInput = z.object({ queue: z.enum(QUEUE_KEYS).default('mine'), sort: z.enum(QUEUE_SORTS).default('sla'), afterNumber: numberInput });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HdtError('invalid_input');
  return result.data;
}
