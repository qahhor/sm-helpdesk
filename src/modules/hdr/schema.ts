import { sql } from 'drizzle-orm';
import { date, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';

// Модуль hdr: справочники. Таблицы, ограничения и политики RLS создают миграции drizzle/0002_hdr_hdc_tables.sql
// и drizzle/0019_sla_calendar.sql. Здесь только описание колонок для запросов.

/** Текст по языкам. Русский вариант обязателен: он запасной для остальных языков. */
export type LocalizedText = { ru: string; uz?: string; en?: string } & Record<string, string | undefined>;

export type ModuleScreen = { code: string; name: LocalizedText };

export const productModules = pgTable('hdr_product_modules', {
  moduleId: uuid('module_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  parentId: uuid('parent_id'),
  name: jsonb('name').$type<LocalizedText>().notNull(),
  screens: jsonb('screens')
    .$type<ModuleScreen[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  state: text('state', { enum: ['active', 'passive'] })
    .notNull()
    .default('active'),
  code: text('code').notNull(),
  ...stampColumns,
});

export type ProductModule = typeof productModules.$inferSelect;

/** График недели: ключ "0".."6" (0 воскресенье), значение ["HH:MM", "HH:MM"] или null для выходного. */
export type WeekHours = Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', [string, string] | null>;

export const businessCalendars = pgTable('hdr_business_calendars', {
  calendarId: uuid('calendar_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  code: text('code').notNull(),
  timezone: text('timezone').notNull(),
  weekHours: jsonb('week_hours').$type<WeekHours>().notNull(),
  holidays: date('holidays', { mode: 'string' })
    .array()
    .notNull()
    .default(sql`'{}'`),
  ...stampColumns,
});

export const slaPolicies = pgTable('hdr_sla_policies', {
  priority: text('priority', { enum: ['p1', 'p2', 'p3', 'p4'] }).primaryKey(),
  firstResponseMinutes: integer('first_response_minutes').notNull(),
  resolutionMinutes: integer('resolution_minutes'),
  resolutionDays: integer('resolution_days'),
  clock: text('clock', { enum: ['business', '24x7'] })
    .notNull()
    .default('business'),
  calendarId: uuid('calendar_id').notNull(),
  ...stampColumns,
});
