import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { cleanUserText } from '@/modules/hdc/pref';
import { HdiError } from './error';
import { DECLINE_REASON_MAX, IDEA_BODY_MAX, IDEA_FILE_MIMES, IDEA_FILES_MAX, IDEA_NUMBER_MAX, IDEA_TITLE_MAX, SIMILAR_QUERY_MAX } from './pref';

// Модуль hdi: схемы Zod для точек входа (docs/naming.md, раздел 5). Автор, организация и голосующий в схемах не
// встречаются вовсе: их берёт сервис из актора (план M7, общие ограничения). Номер идеи служит только поиском строки.

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdiError('invalid_input');
  return parsed.data;
}

/** Текст пользователя: без невидимых знаков (cleanUserText), без пробелов по краям, длина в пределах (решение 13). */
const userText = (max: number) =>
  z
    .string()
    .transform((value) => cleanUserText(value).trim())
    .pipe(z.string().min(1).max(max));

/** Номер идеи: 204 или I-204. */
export const ideaNumber = z.union([
  z.coerce.number().int().positive().max(IDEA_NUMBER_MAX),
  z
    .string()
    .regex(/^I-\d{1,10}$/i)
    .transform((value) => Number(value.slice(2)))
    .pipe(z.number().int().positive().max(IDEA_NUMBER_MAX)),
]);

/** Модуль из справочника или пусто; пустая строка формы тоже пусто. */
const moduleId = z
  .union([z.uuid(), z.literal(''), z.null()])
  .optional()
  .transform((value) => value || null);

// Лишние поля (org_id, author_id и любые другие) отбрасываются, а не принимаются: автор и организация только из актора.
export const submitInput = z.object({
  title: userText(IDEA_TITLE_MAX),
  body: userText(IDEA_BODY_MAX),
  moduleId,
  showOrg: z.boolean().default(false),
  locale: z.enum(LOCALES),
  attachmentIds: z.array(z.uuid()).max(IDEA_FILES_MAX).default([]),
  /** Клиент увидел предупреждение о находках и отправляет всё равно (решение 9). */
  confirmFindings: z.boolean().default(false),
});
export type SubmitInput = z.infer<typeof submitInput>;

export const editInput = z.strictObject({
  number: ideaNumber,
  title: userText(IDEA_TITLE_MAX),
  body: userText(IDEA_BODY_MAX),
  moduleId,
  showOrg: z.boolean(),
});

export const showOrgInput = z.strictObject({ number: ideaNumber, showOrg: z.boolean() });

export const presignInput = z.strictObject({
  purpose: z.literal('idea'),
  fileName: z.string().trim().min(1).max(255),
  size: z.int().min(1),
  mime: z.string().max(100).optional(),
});
export const attachmentInput = z.strictObject({ purpose: z.literal('idea'), attachmentId: z.uuid() });

export const fileMime = z.enum(IDEA_FILE_MIMES);

export const similarInput = z.strictObject({
  text: z.string().max(SIMILAR_QUERY_MAX * 4),
  locale: z.enum(LOCALES),
});

export const publishInput = z.strictObject({ number: ideaNumber, findingsChecked: z.boolean().default(false) });
export const declineInput = z.strictObject({ number: ideaNumber, reason: userText(DECLINE_REASON_MAX) });
export const mergeInput = z.strictObject({ number: ideaNumber, into: ideaNumber });
export const moderatorEditInput = z.strictObject({
  number: ideaNumber,
  title: userText(IDEA_TITLE_MAX),
  body: userText(IDEA_BODY_MAX),
  moduleId,
});
export const translationEditInput = z.strictObject({
  number: ideaNumber,
  locale: z.enum(LOCALES),
  title: userText(IDEA_TITLE_MAX * 2),
  body: userText(IDEA_BODY_MAX * 2),
});
