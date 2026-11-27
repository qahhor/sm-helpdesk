import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, pgView, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { Locale } from '@/i18n/locales';
import type { AnnouncementAudience, AnnouncementKind, BroadcastKind, BroadcastStatus, ProblemStatus } from './pref';

// Модуль hdp: известные проблемы, рассылки, объявления. Таблицы, ограничения, триггеры и политики RLS создаёт миграция
// drizzle/0098_hdp_problems.sql. Здесь только описание колонок для запросов под ролью hub_app (withActor).

/** Известные проблемы (ТЗ 7.15). Счётчики и моменты появления ставит триггер базы пересчётом. */
export const problems = pgTable('hdp_problems', {
  problemId: uuid('problem_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  moduleId: uuid('module_id'),
  workaroundSolutionId: uuid('workaround_solution_id'),
  ownerId: uuid('owner_id'),
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('hdp_problems_number_sq')`),
  internalTitle: text('internal_title').notNull(),
  sourceLocale: text('source_locale').$type<Locale>().notNull().default('ru'),
  showToClients: boolean('show_to_clients').notNull().default(false),
  firstSeenOn: timestamp('first_seen_on', { withTimezone: true }),
  lastSeenOn: timestamp('last_seen_on', { withTimezone: true }),
  fixedOn: timestamp('fixed_on', { withTimezone: true }),
  closedOn: timestamp('closed_on', { withTimezone: true }),
  ticketCount: integer('ticket_count').notNull().default(0),
  orgCount: integer('org_count').notNull().default(0),
  status: text('status').$type<ProblemStatus>().notNull().default('investigating'),
  ...stampColumns,
  /** Внутреннее описание: у черновика AI-сотрудника его текст (веха M8b, решение 20). Миграция 0113. */
  internalDescription: text('internal_description'),
});

/** Обращения, которые черновик проблемы предлагает привязать (веха M8b, решение 20). Миграция 0113. */
export const problemProposals = pgTable('hdp_problem_proposals', {
  orgId: uuid('org_id').notNull(),
  proposalId: uuid('proposal_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  problemId: uuid('problem_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  ...stampColumns,
});

/** Публичные тексты проблемы по языкам. Машинный перевод клиенту не виден до принятия. */
export const problemTranslations = pgTable('hdp_problem_translations', {
  translationId: uuid('translation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  problemId: uuid('problem_id').notNull(),
  acceptedBy: uuid('accepted_by'),
  locale: text('locale').$type<Locale>().notNull(),
  publicTitle: text('public_title').notNull().default(''),
  publicBody: text('public_body').notNull().default(''),
  isMachine: boolean('is_machine').notNull().default(false),
  acceptedOn: timestamp('accepted_on', { withTimezone: true }),
  ...stampColumns,
});

/** Сигнатуры ошибок проблемы. Признак активности ведёт база по статусу проблемы. */
export const problemSignatures = pgTable('hdp_problem_signatures', {
  problemId: uuid('problem_id').notNull(),
  addedBy: uuid('added_by'),
  signature: text('signature').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...stampColumns,
});

/** Что клиент видит о проблеме (решение 2): только показанные, без внутренних полей. */
export const problemsPublic = pgView('hdp_problems_public', {
  problemId: uuid('problem_id').notNull(),
  number: bigint('number', { mode: 'number' }).notNull(),
  status: text('status').$type<ProblemStatus>().notNull(),
  moduleId: uuid('module_id'),
  workaroundSolutionId: uuid('workaround_solution_id'),
  fixedOn: timestamp('fixed_on', { withTimezone: true }),
  locale: text('locale').$type<Locale>().notNull(),
  publicTitle: text('public_title').notNull(),
  publicBody: text('public_body').notNull(),
}).existing();

/** Рассылки обновлений и закрытия проблемы (миграция 0101). Клиент не читает. */
export const broadcasts = pgTable('hdp_broadcasts', {
  broadcastId: uuid('broadcast_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  problemId: uuid('problem_id').notNull(),
  authorId: uuid('author_id').notNull(),
  kind: text('kind').$type<BroadcastKind>().notNull(),
  sourceLocale: text('source_locale').$type<Locale>().notNull(),
  body: jsonb('body').$type<Partial<Record<Locale, string>>>().notNull(),
  machine: jsonb('machine').$type<Partial<Record<Locale, string>>>().notNull().default({}),
  recipientIds: uuid('recipient_ids').array().notNull().default(sql`'{}'`),
  recipientsCount: integer('recipients_count').notNull().default(0),
  orgCount: integer('org_count').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  confirmedOn: timestamp('confirmed_on', { withTimezone: true }),
  sentOn: timestamp('sent_on', { withTimezone: true }),
  status: text('status').$type<BroadcastStatus>().notNull().default('draft'),
  ...stampColumns,
});

/** Объявления (миграция 0103). Клиент видит начавшиеся своей аудитории: действующие и архив за 90 суток. */
export const announcements = pgTable('hdp_announcements', {
  announcementId: uuid('announcement_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  serverId: uuid('server_id'),
  moduleId: uuid('module_id'),
  authorId: uuid('author_id').notNull(),
  kind: text('kind').$type<AnnouncementKind>().notNull(),
  audience: text('audience').$type<AnnouncementAudience>().notNull().default('all'),
  sourceLocale: text('source_locale').$type<Locale>().notNull(),
  startsOn: timestamp('starts_on', { withTimezone: true }).notNull(),
  endsOn: timestamp('ends_on', { withTimezone: true }).notNull(),
  ...stampColumns,
});

/** Заголовок и текст объявления по языкам. Машинный перевод клиенту не виден до принятия. */
export const announcementTranslations = pgTable('hdp_announcement_translations', {
  translationId: uuid('translation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  announcementId: uuid('announcement_id').notNull(),
  acceptedBy: uuid('accepted_by'),
  locale: text('locale').$type<Locale>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  isMachine: boolean('is_machine').notNull().default(false),
  acceptedOn: timestamp('accepted_on', { withTimezone: true }),
  ...stampColumns,
});

/** Закрытые баннеры: свои строки пользователя. */
export const announcementDismissals = pgTable('hdp_announcement_dismissals', {
  userId: uuid('user_id').notNull(),
  announcementId: uuid('announcement_id').notNull(),
  ...stampColumns,
});
