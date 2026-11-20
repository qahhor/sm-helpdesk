import { bigint, pgTable, timestamp } from 'drizzle-orm/pg-core';

// Модуль hdn: уведомления. Таблицы и политики RLS создаёт миграция drizzle/0006_hdu_contacts.sql.

/** Номера принятых событий Telegram: повторная доставка того же события ничего не делает. */
export const telegramUpdates = pgTable('hdn_telegram_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  receivedOn: timestamp('received_on', { withTimezone: true }).notNull().defaultNow(),
});
