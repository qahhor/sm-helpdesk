import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';

// Модуль hdr: справочники. Таблицы, ограничения и политики RLS создаёт миграция
// drizzle/0002_hdr_hdc_tables.sql. Здесь только описание колонок для запросов.

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
