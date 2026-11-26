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
  /** Строка Telegram, к которой письмо запасное (решение 0036, пункт 3). Колонка добавлена миграцией 0040, после служебных. */
  fallbackFor: uuid('fallback_for'),
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
  'telegram_linked',
  // Правила автоматизации (веха M8): правило уведомило сотрудника; система выключила правило из-за зацикливания.
  'rule',
  'rule_disabled',
  // Задача разработки закрыта (веха M8, FR-DEV-05): исполнителю пора проверить и сообщить клиенту.
  'dev_task_closed',
  // Клиент поставил оценку 1 или 2 (веха M8, FR-AUTO-12): предустановленное правило уведомляет Customer Care.
  'csat_low',
  // Защита от зацикливания приостановила правило на одном обращении (проверка вехи M8, находка S1).
  'rule_paused',
  // Идеи (веха M7, задача 8): клиентам о своих идеях и идеях, за которые голосовали или на которые подписаны;
  // роли product об отборе, о модерации и о закрытой задаче разработки идеи.
  'idea_published',
  'idea_declined',
  'idea_status',
  'idea_merged',
  'idea_comment_hidden',
  'idea_official_reply',
  'idea_cycle',
  'idea_moderation_due',
  'idea_dev_task_closed',
  // Предел расходов на AI (веха M5b, решение 11): администраторам, когда отключены организации или помощник у всех.
  'ai_budget',
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
  /** Идея уведомления (веха M7, миграция 0081): переход из колокольчика. */
  ideaId: uuid('idea_id'),
});

export const PREF_KINDS = ['own_tickets', 'watched_tickets', 'staff_mention', 'staff_breach', 'ideas'] as const;
export type PrefKind = (typeof PREF_KINDS)[number];

/** Какие письма и сообщения Telegram получать (10.5 "notification_prefs", FR-NT-04, FR-NT-14). */
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

/** Секреты каналов, заданные администратором (решение 8 вехи M4): токен отдельного бота дежурных. */
export const channelSecrets = pgTable('hdn_channel_secrets', {
  code: text('code').$type<'oncall_telegram_bot'>().primaryKey(),
  sealed: text('sealed').notNull(),
  ...stampColumns,
});

export const INBOUND_CLASSES = ['new', 'reply', 'auto', 'bounce', 'spam', 'review', 'rate_limited', 'ignored'] as const;
export type InboundClass = (typeof INBOUND_CLASSES)[number];

/** Входящие письма (10.5 "email_inbound", решение 10 вехи M4). */
export const emailInbound = pgTable('hdn_email_inbound', {
  inboundId: uuid('inbound_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id'),
  providerId: text('provider_id').notNull(),
  fromAddress: text('from_address').notNull(),
  fromName: text('from_name'),
  toAddresses: text('to_addresses').array().notNull().default(sql`'{}'`),
  ccAddresses: text('cc_addresses').array().notNull().default(sql`'{}'`),
  subject: text('subject').notNull().default(''),
  messageId: text('message_id'),
  headers: jsonb('headers').$type<[string, string][]>(),
  authResult: jsonb('auth_result').$type<{ dmarcAligned: boolean }>(),
  classification: text('classification').$type<InboundClass>(),
  rawRef: text('raw_ref').notNull(),
  receivedOn: moment('received_on').notNull(),
  processedOn: moment('processed_on'),
  ...stampColumns,
});

/** Цепочки писем (10.5 "email_threads", решение 20 вехи M4). */
export const emailThreads = pgTable('hdn_email_threads', {
  threadId: uuid('thread_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id').notNull(),
  messageId: text('message_id').notNull(),
  inReplyTo: text('in_reply_to'),
  direction: text('direction').$type<'in' | 'out'>().notNull(),
  ...stampColumns,
});

/** Отклонённые как спам (решение 14 вехи M4). */
export const blockedSenders = pgTable('hdn_blocked_senders', {
  address: text('address').primaryKey(),
  blockedBy: uuid('blocked_by').notNull(),
  ...stampColumns,
});
