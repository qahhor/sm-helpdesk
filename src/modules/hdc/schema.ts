import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';

// Модуль hdc: ядро. Таблицы, ограничения и политики RLS создаёт миграция
// drizzle/0002_hdr_hdc_tables.sql. Здесь только описание колонок для запросов.

/** Настройки портала, которые администратор меняет без выкладки. Секреты здесь не хранятся. */
export const appSettings = pgTable('hdc_settings', {
  settingId: uuid('setting_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  value: jsonb('value').$type<unknown>().notNull(),
  code: text('code').notNull(),
  ...stampColumns,
});

export type AppSetting = typeof appSettings.$inferSelect;
