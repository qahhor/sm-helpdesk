import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { DeliveryKind, DeliveryStatus, DisabledReason, RuleEventKind, RunResult } from './pref';

// Модуль hdw: автоматизация. Таблицы, ограничения, триггеры и политики RLS создаёт миграция
// drizzle/0058_hdw_rules.sql, drizzle/0061_hdw_webhooks.sql и drizzle/0062_hdw_macros.sql. Здесь только описание колонок для запросов под ролью
// hub_app (withActor).

/** Действие срабатывания в журнале: код, выполнено ли, код причины отказа, прежнее и новое значение. unchanged: менять было нечего. */
export type ActionDone = { action: string; ok: boolean; detail?: string; from?: string | null; to?: string | null; unchanged?: true };

/** Правила автоматизации (ТЗ 7.17). Условия и действия проверяет схема src/modules/hdw/rule-schema.ts. */
export const rules = pgTable('hdw_rules', {
  ruleId: uuid('rule_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text('name').notNull(),
  event: text('event').$type<RuleEventKind>().notNull(),
  /** Через сколько часов молчания срабатывает правило. Только у события no_activity. */
  hours: integer('hours'),
  conditions: jsonb('conditions').$type<unknown>().notNull().default({ match: 'all', items: [] }),
  actions: jsonb('actions').$type<unknown>().notNull(),
  orderNo: integer('order_no').notNull(),
  isStop: boolean('is_stop').notNull().default(false),
  isEnabled: boolean('is_enabled').notNull().default(false),
  disabledReason: text('disabled_reason').$type<DisabledReason>(),
  /** Код предустановленного правила: такое правило нельзя удалить. */
  pcode: text('pcode'),
  ...stampColumns,
  /** Когда правило включили последний раз: граница для события no_activity. Пусто: границы нет. */
  enabledOn: timestamp('enabled_on', { withTimezone: true }),
});

/** Срабатывания правил (FR-AUTO-09). Пишет только система. */
export const ruleRuns = pgTable('hdw_rule_runs', {
  orgId: uuid('org_id').notNull(),
  runId: uuid('run_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ruleId: uuid('rule_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  eventId: uuid('event_id'),
  result: text('result').$type<RunResult>().notNull(),
  actionsDone: jsonb('actions_done').$type<ActionDone[]>().notNull().default([]),
  isDryRun: boolean('is_dry_run').notNull().default(false),
  /** Отметка молчания для события "нет активности": одно срабатывание правила на обращении на молчание. */
  marker: text('marker'),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull().defaultNow(),
});

/** Разрешённые адреса исходящих вебхуков (FR-AUTO-10, FR-ADM-11). */
export const webhookEndpoints = pgTable('hdw_webhook_endpoints', {
  endpointId: uuid('endpoint_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text('name').notNull(),
  url: text('url').notNull(),
  /** Виды событий, на которые подписан адрес. Пусто: адрес вызывает только действие правила. */
  events: text('events')
    .array()
    .notNull()
    .default(sql`'{}'`),
  isEnabled: boolean('is_enabled').notNull().default(true),
  ...stampColumns,
});

/** Секрет подписи адреса, зашифрованный ключом ENCRYPTION_KEY. Читает только система. */
export const webhookSecrets = pgTable('hdw_webhook_secrets', {
  endpointId: uuid('endpoint_id').primaryKey(),
  sealed: text('sealed').notNull(),
  ...stampColumns,
});

/** Тело доставки (решение 11 вехи M8): без темы, описания, переписки, имён и адресов людей. */
export type WebhookBody = {
  event: DeliveryKind;
  occurredOn: string;
  ticket: { number: number; ticketId: string; orgId: string; status: string; priority: string; type: string; queue: string; moduleCode: string | null; tags: string[] };
};

/** Доставки вебхуков: очередь отправки и журнал. Пишет только система. */
export const webhookDeliveries = pgTable('hdw_webhook_deliveries', {
  orgId: uuid('org_id'),
  deliveryId: uuid('delivery_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  endpointId: uuid('endpoint_id').notNull(),
  eventId: uuid('event_id'),
  ticketId: uuid('ticket_id'),
  kind: text('kind').$type<DeliveryKind>().notNull(),
  body: jsonb('body').$type<WebhookBody>().notNull(),
  status: text('status').$type<DeliveryStatus>().notNull().default('queued'),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptOn: timestamp('next_attempt_on', { withTimezone: true }).notNull().defaultNow(),
  ...stampColumns,
});

/** Макросы (FR-AG-15). Действия проверяет схема src/modules/hdw/macro-schema.ts. */
export const macros = pgTable('hdw_macros', {
  macroId: uuid('macro_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text('name').notNull(),
  actions: jsonb('actions').$type<unknown>().notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  orderNo: integer('order_no').notNull(),
  ...stampColumns,
});
