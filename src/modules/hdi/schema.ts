import { sql } from 'drizzle-orm';
import { bigint, boolean, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { Locale } from '@/i18n/locales';
import type { CommentStatus, CycleStatus, IdeaScanStatus, IdeaStatus, IdeaTranslationStatus, VoteMode } from './pref';

// Модуль hdi: идеи. Таблицы, ограничения, триггеры и политики RLS создаёт миграция drizzle/0079_hdi_ideas.sql.
// Здесь только описание колонок для запросов под ролью hub_app (withActor). Счётчики голосов и комментариев пишут
// только триггеры базы, статусы проверяет триггер t_hdi_ideas_guard.

/** Идеи (FR-IDEA-01, 08). Опубликованные видят клиенты всех организаций (решение 2). */
export const ideas = pgTable('hdi_ideas', {
  orgId: uuid('org_id').notNull(),
  ideaId: uuid('idea_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  authorId: uuid('author_id').notNull(),
  moduleId: uuid('module_id'),
  mergedIntoId: uuid('merged_into_id'),
  moderatedBy: uuid('moderated_by'),
  /** Номер для адреса и показа I-<номер>. Задаёт база. */
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('hdi_ideas_sq')`),
  authorName: text('author_name').notNull(),
  authorOrgName: text('author_org_name'),
  showOrg: boolean('show_org').notNull().default(false),
  originalLocale: text('original_locale').$type<Locale>().notNull(),
  voteCount: integer('vote_count').notNull().default(0),
  orgCount: integer('org_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  declineReason: text('decline_reason'),
  findingsChecked: boolean('findings_checked').notNull().default(false),
  selectedCycle: date('selected_cycle', { mode: 'string' }),
  releasedIn: text('released_in'),
  releasedOn: date('released_on', { mode: 'string' }),
  publishedOn: timestamp('published_on', { withTimezone: true }),
  status: text('status').$type<IdeaStatus>().notNull().default('pending_review'),
  ...stampColumns,
});

/** Оригинал и переводы заголовка и описания (FR-IDEA-13, решение 1). */
export const ideaTranslations = pgTable('hdi_idea_translations', {
  translationId: uuid('translation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ideaId: uuid('idea_id').notNull(),
  locale: text('locale').$type<Locale>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  isMachine: boolean('is_machine').notNull().default(false),
  status: text('status').$type<IdeaTranslationStatus>().notNull().default('original'),
  sourceHash: text('source_hash').notNull(),
  ...stampColumns,
});

/** Голоса (FR-IDEA-04, 05). Клиент видит только свой. */
export const ideaVotes = pgTable(
  'hdi_votes',
  {
    orgId: uuid('org_id').notNull(),
    ideaId: uuid('idea_id').notNull(),
    userId: uuid('user_id').notNull(),
    ...stampColumns,
  },
  (table) => [primaryKey({ name: 'hdi_votes_pk', columns: [table.ideaId, table.userId] })],
);

/** Комментарии и ответы Smartup (FR-IDEA-07, решение 8). */
export const ideaComments = pgTable('hdi_comments', {
  orgId: uuid('org_id'),
  commentId: uuid('comment_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ideaId: uuid('idea_id').notNull(),
  authorId: uuid('author_id').notNull(),
  hiddenBy: uuid('hidden_by'),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  isOfficial: boolean('is_official').notNull().default(false),
  hideReason: text('hide_reason'),
  status: text('status').$type<CommentStatus>().notNull().default('published'),
  ...stampColumns,
});

/** Подписки "Следить" (FR-IDEA-11). */
export const ideaSubscriptions = pgTable(
  'hdi_subscriptions',
  {
    ideaId: uuid('idea_id').notNull(),
    userId: uuid('user_id').notNull(),
    ...stampColumns,
  },
  (table) => [primaryKey({ name: 'hdi_subscriptions_pk', columns: [table.ideaId, table.userId] })],
);

/** Строка снимка пятёрки отбора. */
export type ShortlistEntry = { ideaId: string; number: number; voteCount: number; orgCount: number; place: number };

/** Отбор месяца (FR-IDEA-09, 10, 16). */
export const ideaCycles = pgTable('hdi_cycles', {
  cycleId: uuid('cycle_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  leaderIdeaId: uuid('leader_idea_id'),
  selectedIdeaId: uuid('selected_idea_id'),
  decidedBy: uuid('decided_by'),
  cycle: date('cycle', { mode: 'string' }).notNull(),
  shortlist: jsonb('shortlist').$type<ShortlistEntry[]>().notNull().default([]),
  voteMode: text('vote_mode').$type<VoteMode>().notNull(),
  explanationRu: text('explanation_ru'),
  explanationUz: text('explanation_uz'),
  explanationEn: text('explanation_en'),
  decidedOn: timestamp('decided_on', { withTimezone: true }),
  status: text('status').$type<CycleStatus>().notNull().default('open'),
  ...stampColumns,
});

/** Изображения идеи (решение 10). */
export const ideaAttachments = pgTable('hdi_attachments', {
  orgId: uuid('org_id').notNull(),
  attachmentId: uuid('attachment_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  ideaId: uuid('idea_id'),
  uploaderId: uuid('uploader_id').notNull(),
  storageKey: text('storage_key').notNull(),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256'),
  scanStatus: text('scan_status').$type<IdeaScanStatus>().notNull().default('pending'),
  ...stampColumns,
});
