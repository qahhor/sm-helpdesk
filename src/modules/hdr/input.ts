import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/pref';
import { TICKET_TYPES } from '@/modules/hdt/pref';
import { SHORTCUT_PATTERN } from './util';

// Модуль hdr: схема файла выгрузки модулей Smartup для команды hub modules:import (план M2, задача 10).

const text = z.string().trim().min(1, { error: 'пустое значение' }).max(200, { error: 'длиннее 200 знаков' });

/** Название по языкам: русское обязательно, оно запасное для остальных (ограничение hdr_product_modules_c1). */
const localized = z.strictObject({ ru: text, uz: text.optional(), en: text.optional() }, { error: 'ожидается объект с названием ru' });

const code = z
  .string({ error: 'ожидается строка' })
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, { error: 'код: латинские буквы, цифры, _ . : -, до 100 знаков' });

export const moduleRecord = z.strictObject({
  code,
  parentCode: code.nullable().optional(),
  name: localized,
  screens: z.array(z.strictObject({ code, name: localized }), { error: 'ожидается массив экранов' }).max(500).default([]),
});

export const modulesFile = z.array(moduleRecord, { error: 'ожидается массив модулей' }).min(1, { error: 'нет ни одного модуля' }).max(5000);

export type ModuleRecord = z.infer<typeof moduleRecord>;

// --- Сроки и рабочий календарь (план M3, задача 2) ---

const minutes = (max: number) => z.coerce.number().int().min(1).max(max);
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** Сроки приоритета: решение задаётся либо в минутах, либо в рабочих днях (ограничение hdr_sla_policies_c3). */
export const slaPolicyInput = z
  .strictObject({
    priority: z.enum(['p1', 'p2', 'p3', 'p4']),
    firstResponseMinutes: minutes(7 * 24 * 60),
    resolutionMinutes: minutes(60 * 24 * 60).optional(),
    resolutionDays: z.coerce.number().int().min(1).max(60).optional(),
    clock: z.enum(['business', '24x7']),
  })
  .refine((value) => (value.resolutionMinutes === undefined) !== (value.resolutionDays === undefined));

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const dayHours = z
  .tuple([hhmm, hhmm])
  .nullable()
  .refine((value) => value === null || value[0] < value[1]);

/** График недели: семь дней, хотя бы один рабочий. Ключ 0 воскресенье. */
export const calendarInput = z.strictObject({
  timeZone: z.string().trim().min(1).max(64).refine(isTimeZone),
  week: z
    .strictObject({ 0: dayHours, 1: dayHours, 2: dayHours, 3: dayHours, 4: dayHours, 5: dayHours, 6: dayHours })
    .refine((week) => Object.values(week).some((value) => value !== null)),
});

const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });

/** Праздники одного года: даты только этого года, без повторов. */
export const holidaysInput = z
  .strictObject({ year: z.coerce.number().int().min(2024).max(2100), dates: z.array(realDate).max(60) })
  .refine((value) => value.dates.every((date) => date.startsWith(`${value.year}-`)))
  .refine((value) => new Set(value.dates).size === value.dates.length);

/** Памятка первой линии (FR-LINE-10): модуль (пусто: общая для типа), тип обращения, пункты по строкам. */
export const playbookInput = z.object({
  moduleId: z.uuid().nullable(),
  type: z.enum(TICKET_TYPES),
  body: z.string().overwrite(cleanUserText).trim().min(1).max(10000),
});

const templateText = z.string().overwrite(cleanUserText).trim().max(10000);

/** Шаблон ответа (FR-AG-06): код приводится к строчным, русский текст обязателен, пустые переводы отбрасываются. */
export const templateInput = z.object({
  templateId: z.uuid().optional(),
  shortcut: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().regex(SHORTCUT_PATTERN)),
  title: z.string().overwrite(cleanUserText).trim().min(1).max(120),
  body: z
    .object({ ru: templateText.pipe(z.string().min(1)), uz: templateText.optional(), en: templateText.optional() })
    .transform(({ ru, uz, en }) => ({ ru, ...(uz ? { uz } : {}), ...(en ? { en } : {}) })),
  moduleId: z.uuid().nullable().default(null),
  isEnabled: z.boolean().default(true),
});

export const templateQueryInput = z.object({ q: z.string().trim().max(100).optional(), moduleId: z.uuid().nullable().optional() });
