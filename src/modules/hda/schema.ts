import { sql } from 'drizzle-orm';
import { customType, date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { AiCutoffReason, AiDecision, AiHandoffReason, AiOutcome, AiPurpose } from './pref';

// Модуль hda: AI. Таблицы, ограничения и политики создают миграции drizzle/0072_hda_runs.sql и
// drizzle/0091_hda_first_line.sql. Журнал вызовов не хранит текста запроса и ответа (поправка 101).

/** Деньги с шестью знаками после запятой; драйвер отдаёт numeric строкой. */
const usd = customType<{ data: string }>({ dataType: () => 'numeric(12,6)' });
/** Уверенность выбранного решения (score ранжирования). */
const score = customType<{ data: string }>({ dataType: () => 'numeric(10,6)' });
const moment = (name: string) => timestamp(name, { withTimezone: true });

/** Вызовы модели (логическое имя ai_runs): цель, модель, токены, стоимость, время, итог. */
export const aiRuns = pgTable('hda_runs', {
  orgId: uuid('org_id'),
  runId: uuid('run_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  refId: uuid('ref_id'),
  purpose: text('purpose').$type<AiPurpose>().notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: usd('cost_usd').notNull().default('0'),
  latencyMs: integer('latency_ms').notNull().default(0),
  outcome: text('outcome').$type<AiOutcome>().notNull(),
  errorCode: text('error_code'),
  ...stampColumns,
  // Миграция 0091 (веха M5b): обращение, решение кода, повтор, отметка "неверно" и итог разбора.
  /** Обращение первой линии, разбора, перевода сообщения или благодарности. */
  ticketId: uuid('ticket_id'),
  /** Автор текста, ушедшего в модель: суточный предел на пользователя (решение 11). */
  userId: uuid('user_id'),
  decision: text('decision').$type<AiDecision>(),
  handoffReason: text('handoff_reason').$type<AiHandoffReason>(),
  solutionId: uuid('solution_id'),
  confidence: score('confidence'),
  inputHash: text('input_hash'),
  flaggedBy: uuid('flagged_by'),
  flaggedOn: moment('flagged_on'),
  flagReason: text('flag_reason'),
  reviewResult: text('review_result'),
});

/** Организации, отключённые от помощника до конца месяца пределом расходов (план M5b, решение 11). */
export const aiOrgCutoffs = pgTable('hda_org_cutoffs', {
  cutoffId: uuid('cutoff_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  /** Пусто: отключение всех (100% месячного предела). */
  orgId: uuid('org_id'),
  /** Первое число месяца по Ташкенту. */
  month: date('month').notNull(),
  reason: text('reason').$type<AiCutoffReason>().notNull(),
  liftedOn: moment('lifted_on'),
  liftedBy: uuid('lifted_by'),
  ...stampColumns,
});
