import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { checkSolution, type Finding, readiness, type Readiness, solutionBodyText } from '../checks';
import { collectImageFileIds, safeParseSolutionDoc, type SolutionDoc } from '../doc-schema';
import { solutionSlug } from '../slug';
import { compareInvariants, type InvariantIssue } from '../translation';
import { kbArticleFiles, kbArticles, kbArticleTranslations, kbArticleVersions, kbPublished } from '../schema';
import { type ArticleRow, insertDraftTx, versionByIdTx } from './editor';

// Модуль hdk, слой core: публикация, архив и отметка "Текст прочитан" (план M5, задача 4; ТЗ 18.10, FR-SOL-02, 04, 05,
// 17; решения 11, 15, 16). Всё внутри одной транзакции публикующего: откат на любом шаге не оставляет ни опубликованной
// версии, ни копии, ни записи в журнале. Задачу kb.index ставит слой api после фиксации.

/** invariants: расхождения перевода с оригиналом (поправка 101); у оригинала пусто. */
export type Review = { findings: Finding[]; readiness: Readiness; filesNotClean: string[]; invariants: InvariantIssue[] };

/** Действующая опубликованная версия оригинала: с ней сверяется перевод. */
export type OriginalText = { versionId: string; title: string; doc: SolutionDoc };

export async function originalPublishedTx(tx: Tx, article: ArticleRow): Promise<OriginalText | null> {
  const [row] = await tx
    .select({ versionId: kbArticleVersions.versionId, title: kbArticleVersions.title, doc: kbArticleVersions.doc })
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.articleId, article.articleId), eq(kbArticleVersions.locale, article.originalLocale), eq(kbArticleVersions.state, 'published')))
    .limit(1);
  if (!row) return null;
  const doc = safeParseSolutionDoc(row.doc);
  return doc.success ? { versionId: row.versionId, title: row.title, doc: doc.data } : null;
}

/**
 * Проверка FR-SOL-04, панель готовности и файлы документа: только чистые файлы этой статьи. original: для перевода
 * текст оригинала; машинный перевод без расхождений с ним публикуется без отметки "Текст прочитан" (решение 9).
 */
export async function reviewTx(
  tx: Tx,
  article: ArticleRow,
  content: { title: string; doc: SolutionDoc; isMachine: boolean },
  allowedDomains: readonly string[],
  original: OriginalText | null = null,
): Promise<Review> {
  const findings = checkSolution(content, { allowedDomains });
  const invariants = original ? compareInvariants(original, content) : [];
  const fileIds = collectImageFileIds(content.doc);
  const clean =
    fileIds.length === 0
      ? []
      : await tx
          .select({ fileId: kbArticleFiles.fileId })
          .from(kbArticleFiles)
          .where(and(eq(kbArticleFiles.articleId, article.articleId), eq(kbArticleFiles.scanStatus, 'clean'), sql`${kbArticleFiles.fileId} = any(${sql.param(fileIds)}::uuid[])`));
  const cleanIds = new Set(clean.map((row) => row.fileId.toLowerCase()));
  return {
    findings,
    readiness: readiness({ title: content.title, moduleId: article.moduleId, doc: content.doc, isMachine: content.isMachine, findings, machineAllowed: original !== null && invariants.length === 0 }),
    filesNotClean: fileIds.filter((id) => !cleanIds.has(id)),
    invariants,
  };
}

export type PublishInput = { locale: Locale; versionId: string; revision: string; confirmFindings: boolean; allowedDomains: readonly string[] };
export type PublishOutcome =
  | { status: 'published'; versionNumber: number }
  | ({ status: 'not_ready' } & Review)
  | { status: 'conflict' }
  | { status: 'not_found' }
  // Перевод публикуется только при опубликованном оригинале: с ним он сверяется и на него ссылается.
  | { status: 'no_original' };

/**
 * Публикация версии по образцу ТЗ 18.10. Статья заблокирована на время транзакции. Черновик публикуется, только если
 * его версия строки та же, что видел сотрудник. У архивного решения публикуется копия последней опубликованной версии
 * (возврат из архива это новая публикация, решение 11).
 */
export async function publishTx(tx: Tx, article: ArticleRow, input: PublishInput): Promise<PublishOutcome> {
  let version = await versionByIdTx(tx, article.articleId, input.locale, input.versionId);
  if (!version) return { status: 'not_found' };
  if (version.revision !== input.revision) return { status: 'conflict' };
  // Перевод (задача 6, решение 9): только у действующего решения с опубликованным оригиналом, только черновик.
  const isTranslation = input.locale !== article.originalLocale;
  const original = isTranslation ? await originalPublishedTx(tx, article) : null;
  if (isTranslation && (article.status !== 'active' || version.state !== 'draft')) return { status: 'conflict' };
  if (isTranslation && !original) return { status: 'no_original' };
  const republish = article.status === 'archived' && version.state === 'published';
  if (version.state !== 'draft' && !republish) return { status: 'conflict' };
  const parsed = safeParseSolutionDoc(version.doc);
  if (!parsed.success) return { status: 'not_found' };
  const doc = parsed.data;

  const review = await reviewTx(tx, article, { title: version.title, doc, isMachine: version.isMachine }, input.allowedDomains, original);
  // Ссылка вне списка не публикуется никогда, остальные находки только с подтверждением.
  if (!review.readiness.ready || review.filesNotClean.length > 0 || (review.readiness.needsConfirm && !input.confirmFindings)) return { status: 'not_ready', ...review };

  if (republish) {
    const copy = await insertDraftTx(tx, article.articleId, input.locale, { title: version.title, doc, isMachine: false });
    version = (await versionByIdTx(tx, article.articleId, input.locale, copy.versionId))!;
  }
  // Перевод, подтверждённый сотрудником, сверен с действующим оригиналом: он и становится основой перевода. Машинный
  // перевод сохраняет версию оригинала, с которой его сделала модель.
  let outdated = false;
  if (original) {
    if (!version.isMachine) await tx.update(kbArticleVersions).set({ sourceVersionId: original.versionId }).where(eq(kbArticleVersions.versionId, version.versionId));
    outdated = version.isMachine && version.sourceVersionId !== original.versionId;
  }
  // 1. Прежняя опубликованная версия этого языка становится прежней.
  await tx
    .update(kbArticleVersions)
    .set({ state: 'superseded' })
    .where(and(eq(kbArticleVersions.articleId, article.articleId), eq(kbArticleVersions.locale, input.locale), eq(kbArticleVersions.state, 'published')));
  // 2. Черновик становится опубликованной версией.
  await tx.update(kbArticleVersions).set({ state: 'published' }).where(eq(kbArticleVersions.versionId, version.versionId));
  // 3. Строка языка: действующая версия, черновика нет, адрес из заголовка.
  const slug = solutionSlug(version.title);
  await tx
    .update(kbArticleTranslations)
    .set({ publishedVersionId: version.versionId, draftVersionId: null, slug, status: !original ? 'reviewed' : version.isMachine ? (outdated ? 'outdated' : 'machine') : 'reviewed' })
    .where(and(eq(kbArticleTranslations.articleId, article.articleId), eq(kbArticleTranslations.locale, input.locale)));
  // 4. Возврат из архива.
  if (article.status === 'archived') await tx.update(kbArticles).set({ status: 'active', archivedOn: null }).where(eq(kbArticles.articleId, article.articleId));
  // 5. Копия для читателей: единственный источник текста для клиента (ТЗ 10.5). Файлы только чистые (проверено выше).
  const copy = {
    versionId: version.versionId,
    articleNumber: article.number,
    audience: article.audience,
    title: version.title,
    doc,
    bodyText: solutionBodyText(doc),
    slug,
    moduleIds: article.moduleId ? [article.moduleId] : [],
    fileIds: collectImageFileIds(doc),
    originalLocale: article.originalLocale,
    // Машинный перевод клиент видит с пометкой и ссылкой на оригинал (FR-SOL-06), отставший с пометкой (FR-SOL-18).
    isMachine: original !== null && version.isMachine,
    isOutdated: outdated,
    publishedOn: sql`now()`,
  };
  await tx
    .insert(kbPublished)
    .values({ articleId: article.articleId, locale: input.locale, ...copy })
    .onConflictDoUpdate({ target: [kbPublished.articleId, kbPublished.locale], set: copy });
  // 6. Переводы оригинала отстают от него (FR-SOL-18, решение 9).
  if (input.locale === article.originalLocale) {
    await tx
      .update(kbArticleTranslations)
      .set({ status: 'outdated' })
      .where(and(eq(kbArticleTranslations.articleId, article.articleId), ne(kbArticleTranslations.locale, input.locale), ne(kbArticleTranslations.status, 'outdated')));
    await tx
      .update(kbPublished)
      .set({ isOutdated: true })
      .where(and(eq(kbPublished.articleId, article.articleId), ne(kbPublished.locale, input.locale)));
  }
  // 7. Журнал аудита той же транзакцией.
  await writeAudit(tx, {
    action: 'solution.published',
    objectType: 'solution',
    objectId: article.articleId,
    diff: {
      number: article.number,
      locale: input.locale,
      version: version.number,
      findingsConfirmed: review.findings.length,
      machine: version.isMachine,
      republished: republish || article.status === 'archived',
    },
  });
  return { status: 'published', versionNumber: version.number };
}

/**
 * Архив (решение 11): статья archived, копия для читателей удаляется, строки индекса уходят каскадом. Версии, черновик
 * и привязанные сигнатуры остаются; подсказка архивные решения не показывает, адрес открывает "Решение больше не
 * действует".
 */
export async function archiveTx(tx: Tx, article: ArticleRow): Promise<boolean> {
  if (article.status === 'archived') return false;
  await tx
    .update(kbArticles)
    .set({ status: 'archived', archivedOn: sql`now()` })
    .where(eq(kbArticles.articleId, article.articleId));
  const removed = await tx.delete(kbPublished).where(eq(kbPublished.articleId, article.articleId)).returning({ locale: kbPublished.locale });
  await writeAudit(tx, {
    action: 'solution.archived',
    objectType: 'solution',
    objectId: article.articleId,
    diff: { number: article.number, locales: removed.map((r) => r.locale).sort() },
  });
  return true;
}

/** "Текст прочитан" (решение 15): черновик от модели подтверждён сотрудником, запись в журнал той же транзакцией. */
export async function markTextReadTx(tx: Tx, article: ArticleRow, input: { locale: Locale; versionId: string; revision: string }): Promise<{ revision: string } | 'conflict'> {
  const [row] = await tx
    .update(kbArticleVersions)
    .set({ isMachine: false })
    .where(
      and(
        eq(kbArticleVersions.versionId, input.versionId),
        eq(kbArticleVersions.articleId, article.articleId),
        eq(kbArticleVersions.locale, input.locale),
        eq(kbArticleVersions.state, 'draft'),
        eq(kbArticleVersions.isMachine, true),
        sql`${kbArticleVersions.modifiedOn} = ${input.revision}::timestamptz`,
      ),
    )
    .returning({ number: kbArticleVersions.number, revision: sql<string>`${kbArticleVersions.modifiedOn}::text` });
  if (!row) return 'conflict';
  await writeAudit(tx, {
    action: 'solution.text_read',
    objectType: 'solution',
    objectId: article.articleId,
    diff: { number: article.number, locale: input.locale, version: row.number },
  });
  return { revision: row.revision };
}

/** Было ли решение для клиентов и снято в архив: для страницы "Решение больше не действует". Читает система. */
export async function wasArchivedForClientsTx(tx: Tx, number: number): Promise<boolean> {
  const [row] = await tx
    .select({ articleId: kbArticles.articleId })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.number, number),
        eq(kbArticles.status, 'archived'),
        eq(kbArticles.audience, 'clients'),
        sql`exists (select 1 from hdk_article_versions v where v.article_id = ${kbArticles.articleId} and v.state in ('published', 'superseded'))`,
      ),
    )
    .limit(1);
  return Boolean(row);
}
