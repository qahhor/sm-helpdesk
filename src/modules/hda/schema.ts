import { sql } from 'drizzle-orm';
import { boolean, cidr, customType, date, integer, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type {
  AgentCallStatus,
  AgentTool,
  AiCutoffReason,
  AiDecision,
  AiHandoffReason,
  AiOutcome,
  AiPurpose,
  CandidateRejectReason,
  CandidateStatus,
  ReportKind,
  ReportStatus,
  TriageField,
  TriageStatus,
} from './pref';

// Модуль hda: AI. Таблицы, ограничения и политики создают миграции drizzle/0072_hda_runs.sql и
// drizzle/0091_hda_first_line.sql, drizzle/0093_hda_triage.sql, drizzle/0094_hda_review.sql,
// drizzle/0095_hda_message_translations.sql. Журнал вызовов не хранит текста запроса и ответа (поправка 101).

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

/** Машинный перевод сообщения клиента для сотрудника (FR-AG-11; план M5b, решение 24). Клиент не видит, живёт 24 часа. */
export const aiMessageTranslations = pgTable('hda_message_translations', {
  translationId: uuid('translation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  messageId: uuid('message_id').notNull(),
  locale: text('locale').$type<'ru' | 'uz' | 'en'>().notNull(),
  status: text('status').$type<'pending' | 'ready' | 'failed'>().notNull().default('pending'),
  text: text('text'),
  requestedBy: uuid('requested_by').notNull(),
  ...stampColumns,
});

/** Находка проверки текста кандидата для подсветки (FR-CAND-09): вид и найденный кусок. */
export type CandidateFinding = { kind: string; text: string };

/** Кандидаты в решения (логическое имя solution_candidates, веха M5c, задача 9). Миграция 0106. Клиент не видит. */
export const solutionCandidates = pgTable('hda_solution_candidates', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  moduleId: uuid('module_id'),
  articleId: uuid('article_id'),
  decidedBy: uuid('decided_by'),
  locale: text('locale').notNull(),
  title: text('title').notNull(),
  problem: text('problem').notNull().default(''),
  steps: jsonb('steps').$type<string[]>().notNull().default([]),
  findings: jsonb('findings').$type<CandidateFinding[]>().notNull().default([]),
  embedding: vector('embedding', { dimensions: 1024 }),
  status: text('status').$type<CandidateStatus>().notNull().default('new'),
  sourceCount: integer('source_count').notNull().default(0),
  orgCount: integer('org_count').notNull().default(0),
  rejectedAtSourceCount: integer('rejected_at_source_count'),
  rejectReason: text('reject_reason').$type<CandidateRejectReason>(),
  rejectComment: text('reject_comment'),
  decidedOn: moment('decided_on'),
  ...stampColumns,
});

/** Обращения-источники кандидата (логическое имя solution_candidate_sources). Одно обращение, один кандидат. */
export const candidateSources = pgTable('hda_candidate_sources', {
  orgId: uuid('org_id').notNull(),
  sourceId: uuid('source_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  candidateId: uuid('candidate_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  ...stampColumns,
});

// --- AI-сотрудник (веха M8b, задача 1). Миграция 0109. Клиент не видит ни одной строки ---

/** Токены AI-сотрудников (логическое имя agent_tokens). Значение токена не хранится: только хеш и последние 4 знака. */
export const agentTokens = pgTable('hda_agent_tokens', {
  tokenId: uuid('token_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text('name').notNull(),
  staffUserId: uuid('staff_user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenLast4: text('token_last4').notNull(),
  tools: text('tools').array().$type<AgentTool[]>().notNull(),
  allowedIps: cidr('allowed_ips').array().notNull(),
  expiresAt: moment('expires_at').notNull(),
  revokedAt: moment('revoked_at'),
  lastUsedAt: moment('last_used_at'),
  dailyLimit: integer('daily_limit').notNull().default(2000),
  parentTokenId: uuid('parent_token_id'),
  ticketId: uuid('ticket_id'),
  noteLimit: integer('note_limit'),
  notesWritten: integer('notes_written').notNull().default(0),
  isEventParent: boolean('is_event_parent').notNull().default(false),
  ...stampColumns,
});

/** Журнал вызовов инструментов (логическое имя agent_tool_calls). Аргументов и текста ответов нет. */
export const agentToolCalls = pgTable('hda_agent_tool_calls', {
  callId: uuid('call_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  tokenId: uuid('token_id').notNull(),
  tool: text('tool').notNull(),
  argsDigest: text('args_digest'),
  objectRefs: jsonb('object_refs').$type<AgentObjectRef[]>().notNull().default([]),
  status: text('status').$type<AgentCallStatus>().notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  ...stampColumns,
});

/** Объект вызова в журнале: вид и номер (обращение, решение, проблема, идея) или идентификатор (кандидат). */
export type AgentObjectRef = { kind: 'ticket' | 'solution' | 'problem' | 'idea' | 'candidate' | 'report'; ref: string | number };

/** Сводки AI-сотрудника (логическое имя agent_reports). */
export const agentReports = pgTable('hda_agent_reports', {
  reportId: uuid('report_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  kind: text('kind').$type<ReportKind>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  periodFrom: moment('period_from'),
  periodTo: moment('period_to'),
  chatFields: jsonb('chat_fields').$type<Record<string, unknown>>(),
  tokenId: uuid('token_id').notNull(),
  status: text('status').$type<ReportStatus>().notNull().default('unverified'),
  reviewedBy: uuid('reviewed_by'),
  reviewedOn: moment('reviewed_on'),
  ...stampColumns,
});

/** Всплески сигнатур (веха M8b, задача 8; миграция 0114). Пишет система, проблему по всплеску ставит сотрудник. */
export const signatureSpikes = pgTable('hda_signature_spikes', {
  spikeId: uuid('spike_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  problemId: uuid('problem_id'),
  signature: text('signature').notNull(),
  orgCount: integer('org_count').notNull(),
  ticketCount: integer('ticket_count').notNull(),
  windowMinutes: integer('window_minutes').notNull(),
  detectedOn: moment('detected_on').notNull().defaultNow(),
  ...stampColumns,
});

/** Исходящая очередь событий для AI-сотрудника (веха M8b, задача 9; миграция 0115). Только система. */
export const agentEvents = pgTable('hda_agent_events', {
  eventId: uuid('event_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id'),
  spikeId: uuid('spike_id'),
  runTokenId: uuid('run_token_id'),
  kind: text('kind').notNull(),
  body: jsonb('body').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'queued' | 'sent' | 'failed'>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptOn: moment('next_attempt_on').notNull().defaultNow(),
  lastStatus: integer('last_status'),
  sentOn: moment('sent_on'),
  ...stampColumns,
});

export type AgentTokenRow = typeof agentTokens.$inferSelect;
export type AgentToolCallRow = typeof agentToolCalls.$inferSelect;
export type AgentReportRow = typeof agentReports.$inferSelect;
