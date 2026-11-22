import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';

// Модуль hdn: уведомления. Таблицы и политики RLS создают миграции drizzle/0006_hdu_contacts.sql (события
// Telegram), drizzle/0031_outbox.sql (очередь исходящих) и drizzle/0032_notifications.sql (уведомления в портале). Здесь только описание колонок для запросов.

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

export const NOTIFICATION_KINDS = [
  'ticket_created',
  'ticket_reply',
  'ticket_status',
  'ticket_resolved',
  'waiting_reminder',
  'client_replied',
  'mention',
  'sla_breach',
  'snooze_returned',
  'update_due',
  'holidays_reminder',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Уведомления в портале (10.5 "notifications", решение 5 вехи M4). */
export const notifications = pgTable('hdn_notifications', {
  orgId: uuid('org_id'),
  notificationId: uuid('notification_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  ticketId: uuid('ticket_id'),
  kind: text('kind').$type<NotificationKind>().notNull(),
  payload: jsonb('payload').$type<Record<string, string | number>>().notNull().default({}),
  readOn: moment('read_on'),
  ...stampColumns,
});

export const PREF_KINDS = ['watched_tickets', 'staff_mention', 'staff_breach'] as const;
export type PrefKind = (typeof PREF_KINDS)[number];

/** Какие письма получать (10.5 "notification_prefs", FR-NT-04). */
export const notificationPrefs = pgTable(
  'hdn_notification_prefs',
  {
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<PrefKind>().notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    telegramEnabled: boolean('telegram_enabled').notNull().default(true),
    ...stampColumns,
  },
  (table) => [primaryKey({ name: 'hdn_notification_prefs_pk', columns: [table.userId, table.kind] })],
);
