import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { DisabledReason, RuleEventKind, RunResult } from './pref';

// Модуль hdw: автоматизация. Таблицы, ограничения, триггеры и политики RLS создаёт миграция
// drizzle/0058_hdw_rules.sql. Здесь только описание колонок для запросов под ролью hub_app (withActor).

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
