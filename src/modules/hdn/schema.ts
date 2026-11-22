import { sql } from 'drizzle-orm';
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';

// Модуль hdn: уведомления. Таблицы и политики RLS создают миграции drizzle/0006_hdu_contacts.sql (события
// Telegram) и drizzle/0031_outbox.sql (очередь исходящих). Здесь только описание колонок для запросов.

const moment = (name: string) => timestamp(name, { withTimezone: true });

/** Номера принятых событий Telegram: повторная доставка того же события ничего не делает. */
export const telegramUpdates = pgTable('hdn_telegram_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  receivedOn: timestamp('received_on', { withTimezone: true }).notNull().defaultNow(),
});

export type OutboxStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';

/** Очередь исходящих (10.5 "outbox", решения 1-3 вехи M4). */
export const outbox = pgTable('hdn_outbox', {
  outboxId: uuid('outbox_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id'),
  messageId: uuid('message_id'),
  channel: text('channel').$type<'email' | 'telegram'>().notNull(),
  recipientKind: text('recipient_kind').$type<'user' | 'oncall'>().notNull(),
  recipientUserId: uuid('recipient_user_id'),
  recipient: text('recipient'),
  template: text('template').notNull(),
  locale: text('locale').$type<'ru' | 'uz' | 'en'>(),
  settingsPath: text('settings_path'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<OutboxStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptOn: moment('next_attempt_on').notNull().defaultNow(),
  sentOn: moment('sent_on'),
  externalId: text('external_id'),
  lastError: text('last_error'),
  ...stampColumns,
});
