import { sql } from 'drizzle-orm';
import { customType, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { AiCutoffReason, AiDecision, AiHandoffReason, AiOutcome, AiPurpose, TriageField, TriageStatus } from './pref';

// Модуль hda: AI. Таблицы, ограничения и политики создают миграции drizzle/0072_hda_runs.sql и
// drizzle/0091_hda_first_line.sql, drizzle/0093_hda_triage.sql. Журнал вызовов не хранит текста запроса и ответа (поправка 101).

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
  // Миграция 0093 (веха M5b, задача 7): найденные решения для блока AI сотрудника, без текста.
  found: jsonb('found').$type<FoundRef[]>(),
  // Миграция 0094 (веха M5b, задача 8): комментарий сотрудника к отметке "неверно".
  flagComment: text('flag_comment'),
});

/** Найденное решение в строке журнала: идентификатор, номер и оценка ранжирования. */
export type FoundRef = { articleId: string; number: number; score: number };

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

/** Предложения разбора (логическое имя triage_suggestions, FR-TRI-01..06; план M5b, решение 18). Клиент не видит. */
export const aiTriageSuggestions = pgTable('hda_triage_suggestions', {
  suggestionId: uuid('suggestion_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  runId: uuid('run_id').notNull(),
  field: text('field').$type<TriageField>().notNull(),
  value: text('value').notNull(),
  status: text('status').$type<TriageStatus>().notNull().default('pending'),
  decidedBy: uuid('decided_by'),
  decidedOn: moment('decided_on'),
  ...stampColumns,
});

/** Поля разбора, отключённые ночной задачей за низкую долю принятых (FR-TRI-04). */
export const aiTriageFieldOffs = pgTable('hda_triage_field_offs', {
  offId: uuid('off_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  field: text('field').$type<TriageField>().notNull(),
  month: date('month').notNull(),
  share: customType<{ data: string }>({ dataType: () => 'numeric(5,4)' })('share').notNull(),
  decisions: integer('decisions').notNull(),
  liftedOn: moment('lifted_on'),
  liftedBy: uuid('lifted_by'),
  ...stampColumns,
});
