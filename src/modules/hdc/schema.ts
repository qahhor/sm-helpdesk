import { sql } from 'drizzle-orm';
import { bigint, boolean, inet, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { DomainEventKind } from './pref';

// Модуль hdc: ядро. Таблицы, ограничения и политики RLS создают миграции
// drizzle/0002_hdr_hdc_tables.sql и drizzle/0004_hdc_audit_rate.sql. Здесь только описание колонок для запросов.

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

/**
 * Журнал аудита. Только добавление: кто действует и когда, заполняет база.
 * Писать через writeAudit (src/modules/hdc/audit.ts), а не напрямую.
 */
export const auditLog = pgTable('hdc_audit_log', {
  orgId: uuid('org_id'),
  auditId: uuid('audit_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  actorType: text('actor_type')
    .notNull()
    .default(sql`app.actor_type()`),
  actorId: text('actor_id').default(sql`app.user_id()`),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id'),
  diff: jsonb('diff').$type<Record<string, unknown>>(),
  ip: inet('ip').default(sql`app.client_ip()`),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull().defaultNow(),
});

/** Когда дежурным последний раз ушёл сигнал каждого вида (ТЗ 13.8). Работать через src/modules/hdc/ops-alerts.ts. */
export const opsAlerts = pgTable('hdc_ops_alerts', {
  code: text('code').primaryKey(),
  lastSentOn: timestamp('last_sent_on', { withTimezone: true }).notNull(),
  ...stampColumns,
});

/** Отметки удачных резервных копий (миграция 0086; план подготовки M9, решение 6). Пишет команда hub ops:backup-mark. */
export const opsBackups = pgTable('hdc_ops_backups', {
  backupId: uuid('backup_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  kind: text('kind').$type<'dump' | 'base'>().notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  finishedOn: timestamp('finished_on', { withTimezone: true }).notNull(),
  ...stampColumns,
});

/** Отметка "фоновый процесс жив" (миграция 0087; план подготовки M9, решение 5). Одна строка на процесс. */
export const opsHeartbeats = pgTable('hdc_ops_heartbeats', {
  process: text('process').primaryKey(),
  beatOn: timestamp('beat_on', { withTimezone: true }).notNull(),
  ...stampColumns,
});

/** Счётчики ограничения частоты. Работать через consumeRateLimit (src/modules/hdc/rate-limit.ts). */
export const rateLimits = pgTable('hdc_rate_limits', {
  rateLimitId: uuid('rate_limit_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  code: text('code').notNull(),
  windowOn: timestamp('window_on', { withTimezone: true }).notNull(),
  hits: integer('hits').notNull(),
});

/**
 * События предметной области для правил автоматизации (FR-AUTO-02, миграция 0056). Писать через emitEventTx,
 * разбирать через processEvents (src/modules/hdc/events.ts).
 */
export const domainEvents = pgTable('hdc_domain_events', {
  orgId: uuid('org_id').notNull(),
  eventId: uuid('event_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id').notNull(),
  kind: text('kind').$type<DomainEventKind>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  isByRule: boolean('is_by_rule').notNull().default(false),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  processedOn: timestamp('processed_on', { withTimezone: true }),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull().defaultNow(),
  /** Не раньше какого момента разбирать событие снова после сбоя. Колонка добавлена миграцией 0068. */
  nextAttemptOn: timestamp('next_attempt_on', { withTimezone: true }),
});

/** Вид объекта в очереди индекса поиска (миграция 0088). */
export type SearchEntityKind = 'ticket' | 'ticket_text' | 'solution' | 'idea' | 'org' | 'person' | 'config';

/**
 * Очередь записи в индекс поиска Typesense (план W6, миграция 0088): пишут триггеры исходных таблиц, разбирает
 * задача search.sync (src/modules/hdc/search/sync.ts). Только вид и идентификатор, без текста.
 */
export const searchOutbox = pgTable('hdc_search_outbox', {
  orgId: uuid('org_id'),
  outboxId: uuid('outbox_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  entityKind: text('entity_kind').$type<SearchEntityKind>().notNull(),
  entityId: text('entity_id').notNull(),
  op: text('op').$type<'upsert' | 'delete'>().notNull().default('upsert'),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptOn: timestamp('next_attempt_on', { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: text('last_error_code'),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull().defaultNow(),
});
