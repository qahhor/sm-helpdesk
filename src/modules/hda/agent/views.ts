import { bigint, boolean, date, integer, jsonb, pgView, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Представления для AI-сотрудника (веха M8b, задача 2; миграция 0110). Только для запросов инструментов сервера MCP от
// актора agent: строки отбирает база, колонок контактов, названия организации и авторов-пользователей нет. Свободный
// текст перед ответом агенту проходит anonymizeForAgent (./anonymize.ts).

const moment = (name: string) => timestamp(name, { withTimezone: true });
const num = (name: string) => bigint(name, { mode: 'number' });

export const agentTicketsView = pgView('hda_agent_tickets', {
  ticketId: uuid('ticket_id').notNull(),
  number: num('number').notNull(),
  orgId: uuid('org_id').notNull(),
  orgCategory: text('org_category'),
  type: text('type').notNull(),
  status: text('status').notNull(),
  impact: text('impact').notNull(),
  priority: text('priority').notNull(),
  queue: text('queue'),
  moduleId: uuid('module_id'),
  errorSignature: text('error_signature'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  locale: text('locale').notNull(),
  source: text('source').notNull(),
  createdOn: moment('created_on').notNull(),
  modifiedOn: moment('modified_on').notNull(),
  firstResponseDueOn: moment('first_response_due_on'),
  resolutionDueOn: moment('resolution_due_on'),
  firstRespondedOn: moment('first_responded_on'),
  resolvedOn: moment('resolved_on'),
  closedOn: moment('closed_on'),
  firstResponseBreachedOn: moment('first_response_breached_on'),
  resolutionBreachedOn: moment('resolution_breached_on'),
  slaPausedOn: moment('sla_paused_on'),
  clientWaitingSince: moment('client_waiting_since'),
  resolutionType: text('resolution_type'),
  solutionId: uuid('solution_id'),
  knownProblemId: uuid('known_problem_id'),
  mergedIntoId: uuid('merged_into_id'),
  aiState: text('ai_state'),
  aiHandoffReason: text('ai_handoff_reason'),
  aiHandoffOn: moment('ai_handoff_on'),
}).existing();

export const agentMessagesView = pgView('hda_agent_messages', {
  itemKind: text('item_kind').$type<'message' | 'line_transfer'>().notNull(),
  itemId: uuid('item_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  orgId: uuid('org_id').notNull(),
  createdOn: moment('created_on').notNull(),
  authorType: text('author_type').notNull(),
  authorNo: integer('author_no'),
  body: text('body'),
  isInternal: boolean('is_internal').notNull(),
  source: text('source'),
  isAuto: boolean('is_auto').notNull(),
  isThanks: boolean('is_thanks').notNull(),
  aiKind: text('ai_kind'),
  aiSolutionNumber: num('ai_solution_number'),
  aiProblemNumber: num('ai_problem_number'),
  aiHandoffReason: text('ai_handoff_reason'),
  fromLine: text('from_line'),
  toLine: text('to_line'),
  reasonCode: text('reason_code'),
  checked: text('checked'),
  needed: text('needed'),
  explanation: text('explanation'),
}).existing();

export const agentSolutionsView = pgView('hda_agent_solutions', {
  articleId: uuid('article_id').notNull(),
  number: num('number').notNull(),
  locale: text('locale').notNull(),
  type: text('type').notNull(),
  audience: text('audience').notNull(),
  title: text('title').notNull(),
  bodyText: text('body_text').notNull(),
  moduleIds: uuid('module_ids').array().notNull(),
  isMachine: boolean('is_machine').notNull(),
  isOutdated: boolean('is_outdated').notNull(),
  publishedOn: moment('published_on').notNull(),
  shownCount: integer('shown_count').notNull(),
  helpedCount: integer('helped_count').notNull(),
  notHelpedCount: integer('not_helped_count').notNull(),
  staffUsefulCount: integer('staff_useful_count').notNull(),
  articleModifiedOn: moment('article_modified_on').notNull(),
}).existing();

export const agentCandidatesView = pgView('hda_agent_candidates', {
  candidateId: uuid('candidate_id').notNull(),
  moduleId: uuid('module_id'),
  articleId: uuid('article_id'),
  locale: text('locale').notNull(),
  title: text('title').notNull(),
  problem: text('problem').notNull(),
  steps: jsonb('steps').$type<string[]>().notNull(),
  status: text('status').notNull(),
  sourceCount: integer('source_count').notNull(),
  orgCount: integer('org_count').notNull(),
  createdOn: moment('created_on').notNull(),
  modifiedOn: moment('modified_on').notNull(),
  sourceNumbers: num('source_numbers').array().notNull(),
}).existing();

export const agentProblemsView = pgView('hda_agent_problems', {
  problemId: uuid('problem_id').notNull(),
  number: num('number').notNull(),
  status: text('status').notNull(),
  moduleId: uuid('module_id'),
  workaroundSolutionId: uuid('workaround_solution_id'),
  internalTitle: text('internal_title').notNull(),
  showToClients: boolean('show_to_clients').notNull(),
  firstSeenOn: moment('first_seen_on'),
  lastSeenOn: moment('last_seen_on'),
  fixedOn: moment('fixed_on'),
  closedOn: moment('closed_on'),
  ticketCount: integer('ticket_count').notNull(),
  orgCount: integer('org_count').notNull(),
  createdOn: moment('created_on').notNull(),
  modifiedOn: moment('modified_on').notNull(),
  signatures: text('signatures').array().notNull(),
}).existing();

export const agentIdeasView = pgView('hda_agent_ideas', {
  ideaId: uuid('idea_id').notNull(),
  number: num('number').notNull(),
  status: text('status').notNull(),
  moduleId: uuid('module_id'),
  mergedIntoId: uuid('merged_into_id'),
  voteCount: integer('vote_count').notNull(),
  orgCount: integer('org_count').notNull(),
  commentCount: integer('comment_count').notNull(),
  publishedOn: moment('published_on'),
  releasedIn: text('released_in'),
  releasedOn: date('released_on'),
  originalLocale: text('original_locale').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
}).existing();

export const agentSignaturesView = pgView('hda_agent_signatures', {
  signature: text('signature').notNull(),
  moduleId: uuid('module_id'),
  sampleCode: text('sample_code'),
  sampleMessage: text('sample_message'),
  orgCount: integer('org_count').notNull(),
  occurrences: integer('occurrences').notNull(),
  lastSeenOn: moment('last_seen_on'),
  hasSolution: boolean('has_solution').notNull(),
  createdOn: moment('created_on').notNull(),
}).existing();

export const agentSpikesView = pgView('hda_agent_spikes', {
  spikeId: uuid('spike_id').notNull(),
  signature: text('signature').notNull(),
  orgCount: integer('org_count').notNull(),
  ticketCount: integer('ticket_count').notNull(),
  windowMinutes: integer('window_minutes').notNull(),
  detectedOn: moment('detected_on').notNull(),
  problemNumber: num('problem_number'),
  ticketNumbers: num('ticket_numbers').array().notNull(),
}).existing();
