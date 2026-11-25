import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import type { SolutionDoc } from '../doc-schema';
import { collectImageFileIds } from '../doc-schema';
import {
  type ArticleStatus,
  fileQuarantineKey,
  type FileScanStatus,
  type KbAudience,
  REVIEW_MIN_OUTCOMES,
  REVIEW_NOT_HELPED_PERCENT,
  SOLUTION_LIST_LIMIT,
  type SolutionListStatus,
  type VersionState,
} from '../pref';
import { kbArticleFiles, kbArticles, kbArticleTranslations, kbArticleVersions } from '../schema';

// Модуль hdk, слой core: редактор решения, версии и список (план M5, задача 3; UX-W-01..05, 10). Работает внутри
// withActor; права проверяет слой api и ещё раз база (политики и триггеры 0071).
//
// Версия строки для автосохранения: modified_on черновика в текстовом виде базы (с микросекундами). Сохранение
// обновляет черновик, только если метка совпала: второе сохранение из другой вкладки получает конфликт, а не
// затирает чужую правку (ТЗ, "На что смотреть при проверке", пункт 7).

export type ArticleRow = {
  articleId: string;
  number: number;
  moduleId: string | null;
  audience: KbAudience;
  originalLocale: Locale;
  status: ArticleStatus;
  ownerId: string | null;
};

const articleColumns = {
  articleId: kbArticles.articleId,
  number: kbArticles.number,
  moduleId: kbArticles.moduleId,
  audience: kbArticles.audience,
  originalLocale: kbArticles.originalLocale,
  status: kbArticles.status,
  ownerId: kbArticles.ownerId,
};

export async function articleByNumberTx(tx: Tx, number: number, opts: { lock?: boolean } = {}): Promise<ArticleRow | null> {
  const query = tx.select(articleColumns).from(kbArticles).where(eq(kbArticles.number, number)).limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row ?? null;
}

export type VersionRow = {
  versionId: string;
  number: number;
  state: VersionState;
  title: string;
  doc: unknown;
  isMachine: boolean;
  revision: string;
  /** У перевода: версия оригинала, с которой он сделан. */
  sourceVersionId: string | null;
  createdBy: string | null;
  modifiedOn: Date;
};

const versionColumns = {
  versionId: kbArticleVersions.versionId,
  number: kbArticleVersions.number,
  state: kbArticleVersions.state,
  title: kbArticleVersions.title,
  doc: kbArticleVersions.doc,
  isMachine: kbArticleVersions.isMachine,
  revision: sql<string>`${kbArticleVersions.modifiedOn}::text`,
  sourceVersionId: kbArticleVersions.sourceVersionId,
  createdBy: kbArticleVersions.createdBy,
  modifiedOn: kbArticleVersions.modifiedOn,
};

/** Все версии статьи на языке, новые сверху. */
export async function versionsTx(tx: Tx, articleId: string, locale: Locale): Promise<VersionRow[]> {
  return tx
    .select(versionColumns)
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.locale, locale)))
    .orderBy(desc(kbArticleVersions.number));
}

/** lock: строка версии блокируется до конца транзакции (публикация читает то, что опубликует). */
export async function versionByIdTx(tx: Tx, articleId: string, locale: Locale, versionId: string, opts: { lock?: boolean } = {}): Promise<VersionRow | null> {
  const query = tx
    .select(versionColumns)
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.versionId, versionId), eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.locale, locale)))
    .limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * Блокировка текста статьи до конца транзакции (повторная проверка M5, docs/decisions/0057): сохранение черновика,
 * возврат версии, машинный перевод и публикация одной статьи идут по очереди. Без неё автосохранение из второй
 * вкладки между чтением и обновлением публикации оставляло версию published с непроверенным текстом. Блокировка
 * советующая, а не строки статьи: строку архивного решения первая линия заблокировать не может (политика UPDATE).
 */
export async function lockArticleTx(tx: Tx, articleId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hdk.article:${articleId}`}))`);
}

/** Что открывает редактор: черновик, если он есть, иначе действующая опубликованная версия, иначе последняя. */
export function currentVersion(versions: readonly VersionRow[]): VersionRow | null {
  return versions.find((v) => v.state === 'draft') ?? versions.find((v) => v.state === 'published') ?? versions[0] ?? null;
}

async function nextNumberTx(tx: Tx, articleId: string, locale: Locale): Promise<number> {
  const [row] = await tx
    .select({
      next: sql<number>`coalesce(max(${kbArticleVersions.number}), 0)::int + 1`,
    })
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.locale, locale)));
  return row?.next ?? 1;
}

/** Новый черновик на языке: строка версии и ссылка на неё в строке языка (она есть у каждого языка статьи). */
export async function insertDraftTx(
  tx: Tx,
  articleId: string,
  locale: Locale,
  content: { title: string; doc: SolutionDoc; isMachine: boolean; sourceVersionId?: string | null },
): Promise<{ versionId: string; revision: string }> {
  const number = await nextNumberTx(tx, articleId, locale);
  const [row] = await tx
    .insert(kbArticleVersions)
    .values({
      articleId,
      locale,
      number,
      title: content.title,
      doc: content.doc,
      isMachine: content.isMachine,
      sourceVersionId: content.sourceVersionId ?? null,
    })
    .returning({
      versionId: kbArticleVersions.versionId,
      revision: sql<string>`${kbArticleVersions.modifiedOn}::text`,
    });
  await tx
    .update(kbArticleTranslations)
    .set({ draftVersionId: row!.versionId })
    .where(and(eq(kbArticleTranslations.articleId, articleId), eq(kbArticleTranslations.locale, locale)));
  return row!;
}

/** Файлы документа, которых нет у этой статьи: ссылка на чужой или выдуманный файл в черновик не попадает. */
export async function foreignFileIdsTx(tx: Tx, articleId: string, doc: SolutionDoc): Promise<string[]> {
  const ids = collectImageFileIds(doc);
  if (ids.length === 0) return [];
  const own = await tx
    .select({ fileId: kbArticleFiles.fileId })
    .from(kbArticleFiles)
    .where(and(eq(kbArticleFiles.articleId, articleId), sql`${kbArticleFiles.fileId} = any(${sql.param(ids)}::uuid[])`));
  const known = new Set(own.map((row) => row.fileId.toLowerCase()));
  return ids.filter((id) => !known.has(id));
}

export type SaveDraft = {
  articleId: string;
  locale: Locale;
  baseVersionId: string;
  revision: string;
  title: string;
  doc: SolutionDoc;
};

/**
 * Сохранение текста. Основа черновик: обновляется, только если его метка версии не изменилась. Основа опубликованная
 * или прежняя версия: создаётся новый черновик, если его ещё нет (иначе кто-то начал правку раньше: конфликт).
 */
export async function saveDraftTx(tx: Tx, input: SaveDraft): Promise<{ versionId: string; revision: string } | 'conflict' | null> {
  // Основа читается после идущей публикации: сохранение от вытесненной ею версии получает конфликт.
  await lockArticleTx(tx, input.articleId);
  const base = await versionByIdTx(tx, input.articleId, input.locale, input.baseVersionId);
  if (!base) return null;
  if (base.state === 'draft') {
    const [row] = await tx
      .update(kbArticleVersions)
      .set({ title: input.title, doc: input.doc })
      .where(and(eq(kbArticleVersions.versionId, base.versionId), eq(kbArticleVersions.state, 'draft'), sql`${kbArticleVersions.modifiedOn} = ${input.revision}::timestamptz`))
      .returning({
        versionId: kbArticleVersions.versionId,
        revision: sql<string>`${kbArticleVersions.modifiedOn}::text`,
      });
    return row ?? 'conflict';
  }
  if (base.revision !== input.revision) return 'conflict';
  const [draft] = await tx
    .select({ versionId: kbArticleVersions.versionId })
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.articleId, input.articleId), eq(kbArticleVersions.locale, input.locale), eq(kbArticleVersions.state, 'draft')))
    .limit(1);
  if (draft) return 'conflict';
  return insertDraftTx(tx, input.articleId, input.locale, {
    title: input.title,
    doc: input.doc,
    isMachine: false,
    // Перевод помнит версию оригинала, с которой сделан (подсветка изменившихся блоков, UX-W-06).
    sourceVersionId: base.sourceVersionId,
  });
}

/**
 * Возврат к прежней версии (UX-W-04): история не меняется, текст выбранной версии становится черновиком (новым или
 * поверх существующего). Запись в журнал аудита в той же транзакции.
 */
export async function restoreVersionTx(tx: Tx, article: ArticleRow, locale: Locale, versionId: string): Promise<{ versionId: string; revision: string } | null> {
  await lockArticleTx(tx, article.articleId);
  const source = await versionByIdTx(tx, article.articleId, locale, versionId);
  if (!source || source.state === 'draft') return null;
  const [draft] = await tx
    .update(kbArticleVersions)
    .set({
      title: source.title,
      doc: source.doc as SolutionDoc,
      isMachine: source.isMachine,
    })
    .where(and(eq(kbArticleVersions.articleId, article.articleId), eq(kbArticleVersions.locale, locale), eq(kbArticleVersions.state, 'draft')))
    .returning({
      versionId: kbArticleVersions.versionId,
      revision: sql<string>`${kbArticleVersions.modifiedOn}::text`,
    });
  const result =
    draft ??
    (await insertDraftTx(tx, article.articleId, locale, {
      title: source.title,
      doc: source.doc as SolutionDoc,
      isMachine: source.isMachine,
    }));
  await writeAudit(tx, {
    action: 'solution.version_restored',
    objectType: 'solution',
    objectId: article.articleId,
    diff: { number: article.number, locale, from: source.number },
  });
  return result;
}

/** Модуль и аудитория. Смена аудитории это смена прав на чтение: запись в журнал той же транзакцией. */
export async function updateMetaTx(tx: Tx, article: ArticleRow, input: { moduleId: string | null; audience: KbAudience }): Promise<void> {
  await tx.update(kbArticles).set({ moduleId: input.moduleId, audience: input.audience }).where(eq(kbArticles.articleId, article.articleId));
  if (input.audience !== article.audience)
    await writeAudit(tx, {
      action: 'solution.audience_changed',
      objectType: 'solution',
      objectId: article.articleId,
      diff: {
        number: article.number,
        from: article.audience,
        to: input.audience,
      },
    });
}

// --- Список /agent/solutions (UX-W-10) ---

export type ListFilters = {
  status?: SolutionListStatus;
  moduleId?: string;
  locale?: Locale;
  mineOf?: string;
  /** Только решения на пересмотре (FR-SOL-19, решение 18; задача 11). */
  review?: boolean;
};

export type ListRow = {
  articleId: string;
  number: number;
  title: string;
  moduleId: string | null;
  originalLocale: Locale;
  audience: KbAudience;
  status: SolutionListStatus;
  hasDraft: boolean;
  needsReview: boolean;
  /** Показы в подсказке и исходы со страницы решения (FR-SOL-19). */
  shownCount: number;
  helpedCount: number;
  notHelpedCount: number;
  ownerId: string | null;
  updatedOn: Date;
};

/**
 * Решения по фильтрам. mineOf: "Мои задачи" сотрудника, его черновики и его решения на пересмотре (FR-SOL-19,
 * решение 18: "не помогло" больше 40% при 10 исходах и больше).
 */
export async function listArticlesTx(tx: Tx, filters: ListFilters): Promise<ListRow[]> {
  // То же правило, что needsReview в review.ts (тест tests/unit/hdk-review.test.ts).
  const review = sql`(a.helped_count + a.not_helped_count >= ${REVIEW_MIN_OUTCOMES} and a.not_helped_count * 100 > ${REVIEW_NOT_HELPED_PERCENT} * (a.helped_count + a.not_helped_count))`;
  const where = [sql`true`];
  if (filters.status === 'archived') where.push(sql`a.status = 'archived'`);
  if (filters.status === 'published') where.push(sql`a.status = 'active' and p.version_id is not null`);
  if (filters.status === 'draft') where.push(sql`a.status = 'active' and p.version_id is null`);
  if (filters.moduleId) where.push(sql`a.module_id = ${filters.moduleId}::uuid`);
  if (filters.locale) where.push(sql`exists (select 1 from hdk_article_versions v where v.article_id = a.article_id and v.locale = ${filters.locale})`);
  if (filters.review) where.push(review);
  if (filters.mineOf) where.push(sql`a.owner_id = ${filters.mineOf}::uuid and a.status = 'active' and (d.version_id is not null or ${review})`);
  const result = await tx.execute<{
    article_id: string;
    number: string;
    title: string;
    module_id: string | null;
    original_locale: Locale;
    audience: KbAudience;
    article_status: ArticleStatus;
    is_published: boolean;
    has_draft: boolean;
    needs_review: boolean;
    shown_count: number;
    helped_count: number;
    not_helped_count: number;
    owner_id: string | null;
    updated_on: Date;
  }>(sql`
    select a.article_id, a.number, coalesce(nullif(d.title, ''), p.title, '') as title, a.module_id, a.original_locale, a.audience,
           a.status as article_status, p.version_id is not null as is_published, d.version_id is not null as has_draft,
           ${review} as needs_review, a.shown_count, a.helped_count, a.not_helped_count, a.owner_id,
           greatest(a.modified_on, coalesce(d.modified_on, a.modified_on), coalesce(p.modified_on, a.modified_on)) as updated_on
      from hdk_articles a
      left join hdk_article_versions d on d.article_id = a.article_id and d.locale = a.original_locale and d.state = 'draft'
      left join hdk_article_versions p on p.article_id = a.article_id and p.locale = a.original_locale and p.state = 'published'
     where ${sql.join(where, sql` and `)}
     order by updated_on desc
     limit ${SOLUTION_LIST_LIMIT}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    number: Number(row.number),
    title: row.title,
    moduleId: row.module_id,
    originalLocale: row.original_locale,
    audience: row.audience,
    status: row.article_status === 'archived' ? 'archived' : row.is_published ? 'published' : 'draft',
    hasDraft: row.has_draft,
    needsReview: row.needs_review,
    shownCount: Number(row.shown_count),
    helpedCount: Number(row.helped_count),
    notHelpedCount: Number(row.not_helped_count),
    ownerId: row.owner_id,
    updatedOn: new Date(row.updated_on),
  }));
}

// --- Файлы решения (UX-W-03, решение 16) ---

export type FileRow = {
  fileId: string;
  articleId: string;
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  scanStatus: FileScanStatus;
};

const fileColumns = {
  fileId: kbArticleFiles.fileId,
  articleId: kbArticleFiles.articleId,
  storageKey: kbArticleFiles.storageKey,
  fileName: kbArticleFiles.fileName,
  mime: kbArticleFiles.mime,
  size: kbArticleFiles.size,
  scanStatus: kbArticleFiles.scanStatus,
};

/** Строка файла в карантине: ключ хранилища из идентификатора, его задаёт база. */
export async function createFileTx(tx: Tx, articleId: string, upload: { fileName: string; mime: string; size: number }): Promise<string> {
  const result = await tx.execute<{ file_id: string }>(sql`
    insert into hdk_article_files (file_id, article_id, storage_key, file_name, mime, size, scan_status)
    select id, ${articleId}::uuid, 'quarantine/kb/' || id, ${upload.fileName}, ${upload.mime}, ${upload.size}, 'pending'
      from (select uuidv7() as id) as generated
    returning file_id`);
  const id = result.rows[0]?.file_id;
  if (!id) throw new Error('hdk: файл не создан');
  if (fileQuarantineKey(id).length > 300) throw new Error('hdk: ключ файла длиннее предела');
  return id;
}

export async function fileByIdTx(tx: Tx, fileId: string): Promise<FileRow | null> {
  const [row] = await tx.select(fileColumns).from(kbArticleFiles).where(eq(kbArticleFiles.fileId, fileId)).limit(1);
  return row ?? null;
}
