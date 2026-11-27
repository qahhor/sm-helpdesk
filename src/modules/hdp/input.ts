import * as z from 'zod';
import { LOCALES } from '@/i18n/locales';
import { HdpError } from './error';
import { PROBLEM_BODY_MAX, PROBLEM_NUMBER_MAX, PROBLEM_TITLE_MAX, SETTABLE_PROBLEM_STATUSES } from './pref';

// Модуль hdp, слой input: схемы Zod точек входа (docs/naming.md, раздел 5).

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdpError('invalid_input');
  return parsed.data;
}

const number = z.number().int().positive().max(PROBLEM_NUMBER_MAX);
const ticketNumber = z.number().int().positive().max(999_999_999_999);
const title = z.string().trim().min(1).max(PROBLEM_TITLE_MAX);
export const signatureValue = z.string().regex(/^[0-9a-f]{32}$/);

export const problemNumberInput = number;
export const createProblemInput = z.strictObject({ internalTitle: title, moduleId: z.uuid().nullable().optional() });
export const fromTicketInput = z.strictObject({ ticketNumber });
export const saveProblemInput = z.strictObject({
  number,
  internalTitle: title,
  moduleId: z.uuid().nullable(),
  /** Номер решения обходного пути; null: без обходного пути. */
  workaroundNumber: z.number().int().positive().max(999_999_999).nullable(),
});
export const statusInput = z.strictObject({ number, status: z.enum(SETTABLE_PROBLEM_STATUSES) });
export const shownInput = z.strictObject({ number, shown: z.boolean() });
export const signatureInput = z.strictObject({ number, signature: signatureValue });
export const translationInput = z.strictObject({
  number,
  locale: z.enum(LOCALES),
  publicTitle: z.string().trim().max(PROBLEM_TITLE_MAX),
  publicBody: z.string().max(PROBLEM_BODY_MAX),
  acceptMachine: z.boolean().optional(),
});
export const requestTranslationInput = z.strictObject({ number, locale: z.enum(LOCALES) });
export const listInput = z.strictObject({
  status: z.enum(['investigating', 'cause_found', 'fixing', 'fixed', 'closed', 'active']).optional(),
  moduleId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
});
