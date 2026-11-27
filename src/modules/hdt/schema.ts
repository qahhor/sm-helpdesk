import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type {
  AiHandoffReason,
  AiPayload,
  AiState,
  AuthorType,
  CsatReason,
  EventKind,
  Impact,
  Priority,
  PresenceMode,
  Queue,
  ScanStatus,
  TicketSource,
  TicketStatus,
  TicketType,
  Visibility,
  WatcherSource,
} from './pref';

// Модуль hdt: обращения. Таблицы, ограничения, триггеры и политики RLS создаёт миграция
// drizzle/0011_hdt_tickets.sql. Здесь только описание колонок для запросов под ролью hub_app (withActor).

const moment = (name: string) => timestamp(name, { withTimezone: true });

/** Контекст из Smartup (веха M6): экран, версия, платформа, код и текст ошибки, код модуля из подсказки виджета. */
export type TicketContext = { screen?: string; version?: string; platform?: string; errorCode?: string; errorText?: string; moduleCode?: string };

export const tickets = pgTable('hdt_tickets', {
  ticketId: uuid('ticket_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('hdt_tickets_number_sq')`),
  authorId: uuid('author_id').notNull(),
  type: text('type').$type<TicketType>().notNull(),
  status: text('status').$type<TicketStatus>().notNull().default('new'),
  impact: text('impact').$type<Impact>().notNull(),
  priority: text('priority').$type<Priority>().notNull(),
  priorityConfirmed: boolean('priority_confirmed').notNull().default(false),
  visibility: text('visibility').$type<Visibility>().notNull().default('org'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  locale: text('locale').notNull(),
  moduleId: uuid('module_id'),
  context: jsonb('context').$type<TicketContext>(),
  errorSignature: text('error_signature'),
  source: text('source').$type<TicketSource>().notNull(),
  assigneeId: uuid('assignee_id'),
  queue: text('queue').$type<Queue>().notNull().default('l1'),
  firstResponseDueOn: moment('first_response_due_on'),
  resolutionDueOn: moment('resolution_due_on'),
  firstRespondedOn: moment('first_responded_on'),
  resolvedOn: moment('resolved_on'),
  slaPausedOn: moment('sla_paused_on'),
  slaPausedMinutes: integer('sla_paused_minutes').notNull().default(0),
  resolutionType: text('resolution_type'),
  solutionId: uuid('solution_id'),
  mergedIntoId: uuid('merged_into_id'),
  knownProblemId: uuid('known_problem_id'),
  relatedTicketId: uuid('related_ticket_id'),
  snoozedUntil: moment('snoozed_until'),
  aiState: text('ai_state').$type<AiState>().notNull().default('none'),
  aiReplyCount: smallint('ai_reply_count').notNull().default(0),
  aiHandoffReason: text('ai_handoff_reason').$type<AiHandoffReason>(),
  lastClientMessageOn: moment('last_client_message_on'),
  csatScore: smallint('csat_score'),
  csatReason: text('csat_reason').$type<CsatReason>(),
  csatComment: text('csat_comment'),
  closedOn: moment('closed_on'),
  ...stampColumns,
  // Миграция 0020 добавила колонки в конец таблицы.
  firstResponseBreachedOn: moment('first_response_breached_on'),
  resolutionBreachedOn: moment('resolution_breached_on'),
  clientWaitingSince: moment('client_waiting_since'),
  resolvedVersion: text('resolved_version'),
  // Миграция 0033 (веха M4): напоминание клиенту в "Ждём вашего ответа".
  waitingRemindedOn: moment('waiting_reminded_on'),
  // Миграция 0034 (веха M4): сообщение дежурным о P1 и напоминание о регулярном обновлении.
  oncallNotifiedOn: moment('oncall_notified_on'),
  updateRemindedOn: moment('update_reminded_on'),
  // Миграция 0035 (веха M4): письмо с домена организации от неподтверждённого адреса (FR-EM-06).
  senderUnconfirmed: boolean('sender_unconfirmed').notNull().default(false),
  // Миграция 0049 (волна 3): пометка "вернулось из отложенных".
  /** Когда обращение вернулось из отложенных (FR-AG-13). Пусто после первого действия сотрудника. */
  snoozeReturnedOn: moment('snooze_returned_on'),
  // Миграция 0056 (веха M8): момент, когда срок станет близким. Задача раз в минуту пишет событие и очищает колонку.
  /** Когда срок первого ответа станет близким. Пусто: события "срок скоро" не ждём. */
  firstResponseSoonOn: moment('first_response_soon_on'),
  /** Когда срок решения станет близким. Пусто: события "срок скоро" не ждём. */
  resolutionSoonOn: moment('resolution_soon_on'),
  // Миграция 0064 (веха M8): заметка руководителя о разборе низкой оценки (FR-MET-07). Клиенту не отдаётся:
  // запросы клиента эти три колонки не выбирают (core/tickets.ts, clientTicketColumns).
  /** Заметка о разборе оценки 1-3. Пишут Customer Care и администратор. */
  csatReviewNote: text('csat_review_note'),
  csatReviewedBy: uuid('csat_reviewed_by'),
  csatReviewedOn: moment('csat_reviewed_on'),
  // Миграция 0092 (веха M5b): момент передачи помощником сотрудникам, от него считается срок первого ответа (FR-SLA-10).
  aiHandoffOn: moment('ai_handoff_on'),
});

export const ticketMessages = pgTable('hdt_ticket_messages', {
  messageId: uuid('message_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  authorId: uuid('author_id'),
  authorType: text('author_type').$type<AuthorType>().notNull(),
  body: text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),
  source: text('source').$type<TicketSource>().notNull().default('portal'),
  emailMessageId: text('email_message_id'),
  ...stampColumns,
  // Колонка добавлена миграцией 0029 и стоит в конце таблицы.
  isThanks: boolean('is_thanks').notNull().default(false),
  // Миграция 0058 (веха M8): сообщение написано правилом автоматизации (FR-AUTO-11).
  /** Автоматический ответ по шаблону или заметка правила. Автор такого сообщения всегда система. */
  isAuto: boolean('is_auto').notNull().default(false),
  // Миграция 0092 (веха M5b): ссылки сообщения помощника вместо текста (решение 9). Есть только у author_type = ai.
  aiPayload: jsonb('ai_payload').$type<AiPayload>(),
  // Миграция 0101 (веха M5c): сообщение рассылки по известной проблеме. Одно на обращение и рассылку.
  broadcastId: uuid('broadcast_id'),
});

export const ticketEvents = pgTable('hdt_ticket_events', {
  eventId: uuid('event_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  kind: text('kind').$type<EventKind>().notNull(),
  actorType: text('actor_type').$type<AuthorType>().notNull(),
  actorId: uuid('actor_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  isInternal: boolean('is_internal').notNull().default(false),
  ...stampColumns,
});

export const ticketWatchers = pgTable('hdt_ticket_watchers', {
  watcherId: uuid('watcher_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  userId: uuid('user_id').notNull(),
  source: text('source').$type<WatcherSource>().notNull(),
  ...stampColumns,
});

export const attachments = pgTable('hdt_attachments', {
  attachmentId: uuid('attachment_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id'),
  messageId: uuid('message_id'),
  uploaderId: uuid('uploader_id').notNull(),
  storageKey: text('storage_key').notNull(),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256'),
  scanStatus: text('scan_status').$type<ScanStatus>().notNull().default('pending'),
  scanSignature: text('scan_signature'),
  detectedType: text('detected_type'),
  isInternal: boolean('is_internal').notNull().default(false),
  ...stampColumns,
  // Миграция 0050 (волна 3): когда антивирус закончил проверку. По нему считается сигнал о заражённых файлах.
  scannedOn: moment('scanned_on'),
});

/** Условия сохранённого списка рабочего места. */
export type SavedQuery = { queue: string; sort?: string; q?: string };

export const savedFilters = pgTable('hdt_saved_filters', {
  filterId: uuid('filter_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  query: jsonb('query').$type<SavedQuery>().notNull(),
  isShared: boolean('is_shared').notNull().default(false),
  ...stampColumns,
});

export const ticketReads = pgTable('hdt_ticket_reads', {
  ticketId: uuid('ticket_id').notNull(),
  userId: uuid('user_id').notNull(),
  /** Пусто: строку создала запись о чтении в журнале аудита, отметку "просмотрено" страница ещё не поставила. */
  seenOn: moment('seen_on'),
  ...stampColumns,
  /** Когда открытие обращения последний раз записано в журнал аудита (не чаще раза в час). Колонка добавлена миграцией 0045, в базе она последняя. */
  viewLoggedOn: moment('view_logged_on'),
});

export const replyDrafts = pgTable('hdt_reply_drafts', {
  ticketId: uuid('ticket_id').notNull(),
  userId: uuid('user_id').notNull(),
  body: text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),
  ...stampColumns,
});

export const ticketPresence = pgTable('hdt_ticket_presence', {
  ticketId: uuid('ticket_id').notNull(),
  userId: uuid('user_id').notNull(),
  mode: text('mode').$type<PresenceMode>().notNull(),
  expiresOn: moment('expires_on').notNull(),
  ...stampColumns,
});

export const mentions = pgTable('hdt_mentions', {
  messageId: uuid('message_id').notNull(),
  userId: uuid('user_id').notNull(),
  readOn: moment('read_on'),
  ...stampColumns,
});

export const lineTransfers = pgTable('hdt_ticket_line_transfers', {
  transferId: uuid('transfer_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id').notNull(),
  fromLine: text('from_line').$type<Queue>().notNull(),
  toLine: text('to_line').$type<Queue>().notNull(),
  reasonCode: text('reason_code'),
  checked: text('checked'),
  needed: text('needed'),
  explanation: text('explanation'),
  checklist: jsonb('checklist').$type<string[]>().notNull().default([]),
  byUser: uuid('by_user').notNull(),
  pickupDueOn: moment('pickup_due_on'),
  pickedUpOn: moment('picked_up_on'),
  pickedUpBy: uuid('picked_up_by'),
  ...stampColumns,
});

/** Теги на обращении (FR-AUTO-13, миграция 0055). Справочник тегов в модуле hdr; клиент строк не видит. */
export const ticketTags = pgTable('hdt_ticket_tags', {
  orgId: uuid('org_id').notNull(),
  ticketTagId: uuid('ticket_tag_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ticketId: uuid('ticket_id').notNull(),
  tagId: uuid('tag_id').notNull(),
  /** Сотрудник, который поставил тег. Пусто: поставило правило автоматизации. */
  addedBy: uuid('added_by'),
  ...stampColumns,
});
