import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, integer, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { Locale } from '@/i18n/locales';
import type {
  ArticleStatus,
  AiJobStatus,
  ArticleType,
  DeflectionOutcome,
  DeflectionZone,
  FileMime,
  FileScanStatus,
  KbAudience,
  SearchKind,
  TranslationStatus,
  VersionState,
} from './pref';

// Модуль hdk: знания. Таблицы, ограничения, триггеры и политики RLS создаёт миграция drizzle/0071_hdk_knowledge.sql.
// Здесь только описание колонок для запросов под ролью hub_app (withActor). Клиент читает только hdk_published и
// hdk_search_documents с аудиторией clients; остальные таблицы ему закрыты политиками.

/** Полнотекстовый вектор PostgreSQL. Заполняет триггер базы (задача 9), приложение его не пишет. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/** Документ решения в базе. Перед записью и отрисовкой его проверяет схема (doc-schema.ts). */
type StoredDoc = { version: 1; blocks: unknown[] };

/** Статьи; на этапе 1 только решения (FR-SOL-01). */
export const kbArticles = pgTable('hdk_articles', {
  articleId: uuid('article_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  moduleId: uuid('module_id'),
  ownerId: uuid('owner_id'),
  /** Номер для адреса /help/a/<номер>-<slug>. Задаёт база. */
  number: bigint('number', { mode: 'number' })
    .notNull()
    .default(sql`nextval('hdk_articles_number_sq')`),
  type: text('type').$type<ArticleType>().notNull().default('solution'),
  audience: text('audience').$type<KbAudience>().notNull().default('clients'),
  originalLocale: text('original_locale').$type<Locale>().notNull(),
  shownCount: integer('shown_count').notNull().default(0),
  helpedCount: integer('helped_count').notNull().default(0),
  notHelpedCount: integer('not_helped_count').notNull().default(0),
  archivedOn: timestamp('archived_on', { withTimezone: true }),
  status: text('status').$type<ArticleStatus>().notNull().default('active'),
  ...stampColumns,
  /** Пригодилось сотрудникам (веха M5c, FR-CAND-03): похожие закрытые обращения без решения. Миграция 0106. */
  staffUsefulCount: integer('staff_useful_count').notNull().default(0),
  /** Решение из кандидата (веха M5c, решение 30): находки недоверенного текста отмечаются по одной. Миграция 0107. */
  isUntrusted: boolean('is_untrusted').notNull().default(false),
});

/** Версии текста по языкам: черновик, опубликованная, прежние. */
export const kbArticleVersions = pgTable('hdk_article_versions', {
  versionId: uuid('version_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id').notNull(),
  sourceVersionId: uuid('source_version_id'),
  locale: text('locale').$type<Locale>().notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull().default(''),
  doc: jsonb('doc').$type<StoredDoc>().notNull(),
  isMachine: boolean('is_machine').notNull().default(false),
  state: text('state').$type<VersionState>().notNull().default('draft'),
  ...stampColumns,
  /** Отметки "Проверено" находок недоверенного текста (веха M5c, решение 30). Миграция 0107. */
  untrustedConfirmed: jsonb('untrusted_confirmed').$type<{ textHash: string; fingerprints: string[] }>(),
});

/** Языки статьи: строка на каждый язык, включая оригинал. */
export const kbArticleTranslations = pgTable('hdk_article_translations', {
  translationId: uuid('translation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id').notNull(),
  publishedVersionId: uuid('published_version_id'),
  draftVersionId: uuid('draft_version_id'),
  locale: text('locale').$type<Locale>().notNull(),
  slug: text('slug').notNull().default(''),
  status: text('status').$type<TranslationStatus>().notNull().default('reviewed'),
  ...stampColumns,
  // Миграция 0073 (задачи 6 и 7): состояние последней задачи модели для этого языка.
  aiStatus: text('ai_status').$type<AiJobStatus>(),
});

/** Обращения, из которых выросло решение (FR-SOL-02). Видны только сотрудникам. */
export const kbArticleSources = pgTable('hdk_article_sources', {
  orgId: uuid('org_id').notNull(),
  sourceId: uuid('source_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  ...stampColumns,
});

/** Копия опубликованной версии для читателей: единственный источник текста решения для клиента. */
export const kbPublished = pgTable('hdk_published', {
  publishedId: uuid('published_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id').notNull(),
  versionId: uuid('version_id').notNull(),
  articleNumber: bigint('article_number', { mode: 'number' }).notNull(),
  locale: text('locale').$type<Locale>().notNull(),
  type: text('type').$type<ArticleType>().notNull().default('solution'),
  audience: text('audience').$type<KbAudience>().notNull(),
  title: text('title').notNull(),
  doc: jsonb('doc').$type<StoredDoc>().notNull(),
  bodyText: text('body_text').notNull(),
  slug: text('slug').notNull(),
  moduleIds: uuid('module_ids').array().notNull().default(sql`'{}'`),
  /** Файлы, на которые ссылается документ: клиент скачивает только их (решение 16). */
  fileIds: uuid('file_ids').array().notNull().default(sql`'{}'`),
  originalLocale: text('original_locale').$type<Locale>().notNull(),
  isMachine: boolean('is_machine').notNull().default(false),
  isOutdated: boolean('is_outdated').notNull().default(false),
  publishedOn: timestamp('published_on', { withTimezone: true }).notNull().defaultNow(),
  ...stampColumns,
});

/** Изображения решений (решение 16). */
export const kbArticleFiles = pgTable('hdk_article_files', {
  fileId: uuid('file_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id').notNull(),
  storageKey: text('storage_key').notNull(),
  fileName: text('file_name').notNull(),
  mime: text('mime').$type<FileMime>().notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256'),
  scanStatus: text('scan_status').$type<FileScanStatus>().notNull().default('pending'),
  ...stampColumns,
});

/** Сигнатуры ошибок Smartup (FR-SOL-07, ТЗ 11.5). */
export const kbErrorSignatures = pgTable('hdk_error_signatures', {
  signatureId: uuid('signature_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  articleId: uuid('article_id'),
  moduleId: uuid('module_id'),
  signature: text('signature').notNull(),
  sampleCode: text('sample_code'),
  sampleMessage: text('sample_message'),
  orgCount: integer('org_count').notNull().default(0),
  occurrences: integer('occurrences').notNull().default(0),
  lastSeenOn: timestamp('last_seen_on', { withTimezone: true }),
  ...stampColumns,
});

/** Организации, у которых встречалась сигнатура (решение 8). */
export const kbSignatureOrgs = pgTable('hdk_signature_orgs', {
  orgId: uuid('org_id').notNull(),
  signatureOrgId: uuid('signature_org_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  signatureId: uuid('signature_id').notNull(),
  firstSeenOn: timestamp('first_seen_on', { withTimezone: true }).notNull().defaultNow(),
  lastSeenOn: timestamp('last_seen_on', { withTimezone: true }).notNull().defaultNow(),
  ...stampColumns,
});

/** Общий поисковый индекс (ТЗ 10.4): только опубликованное. Триггер tsv и индексы добавляет задача 9. */
export const kbSearchDocuments = pgTable('hdk_search_documents', {
  searchDocumentId: uuid('search_document_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  publishedId: uuid('published_id'),
  moduleId: uuid('module_id'),
  refId: uuid('ref_id').notNull(),
  kind: text('kind').$type<SearchKind>().notNull(),
  articleType: text('article_type').$type<ArticleType>(),
  locale: text('locale').$type<Locale>().notNull(),
  title: text('title').notNull(),
  bodyText: text('body_text').notNull(),
  tsv: tsvector('tsv'),
  embedding: vector('embedding', { dimensions: 1024 }),
  audience: text('audience').$type<KbAudience>().notNull().default('internal'),
  ...stampColumns,
});

/** Показы подсказки и их исходы, строка на сессию формы (решение 12). */
export const kbDeflectionEvents = pgTable('hdk_deflection_events', {
  orgId: uuid('org_id').notNull(),
  deflectionEventId: uuid('deflection_event_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  ticketId: uuid('ticket_id'),
  sessionId: uuid('session_id').notNull(),
  queryHash: text('query_hash').notNull(),
  signature: text('signature'),
  shownArticleIds: uuid('shown_article_ids').array().notNull().default(sql`'{}'`),
  outcome: text('outcome').$type<DeflectionOutcome>().notNull().default('left'),
  zone: text('zone').$type<DeflectionZone>().notNull().default('portal'),
  ...stampColumns,
});

/**
 * Запросы подсказки без результата (план W6, решение 17; миграция 0089): строка на сессию формы, текст после маски
 * данных, 90 дней. Пишет система, читают администратор и роли публикации решений.
 */
export const kbSuggestMisses = pgTable('hdk_suggest_misses', {
  missId: uuid('miss_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  moduleId: uuid('module_id'),
  sessionId: uuid('session_id').notNull(),
  locale: text('locale').$type<Locale>().notNull(),
  queryText: text('query_text').notNull(),
  ...stampColumns,
});
