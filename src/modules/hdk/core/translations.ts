import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { LOCALES, type Locale } from '@/i18n/locales';
import { safeParseSolutionDoc, type SolutionDoc } from '../doc-schema';
import type { AiJobStatus, TranslationStatus } from '../pref';
import { kbArticles, kbArticleTranslations, kbArticleVersions } from '../schema';
import { type ArticleRow, insertDraftTx, lockArticleTx } from './editor';
import { changedBlockIds } from '../translation';
import { originalPublishedTx } from './publish';

// Модуль hdk, слой core: переводы решения (план M5, задача 6; FR-SOL-06, 18, UX-W-06, решение 9). Перевод это строка
// языка в hdk_article_translations и версии на этом языке. Черновик перевода начинается копией опубликованного
// оригинала (те же идентификаторы блоков) и помнит версию оригинала (source_version_id). Машинный перевод пишет
// задача kb.translate от имени системы с пометкой is_machine. Публикует перевод publishTx (core/publish.ts).

export type LanguageRow = {
  locale: Locale;
  isOriginal: boolean;
  /** Состояние опубликованного перевода; null: языка у статьи нет. */
  status: TranslationStatus | null;
  aiStatus: AiJobStatus | null;
  published: boolean;
  draft: boolean;
};

export async function languagesTx(tx: Tx, article: ArticleRow): Promise<LanguageRow[]> {
  const rows = await tx
    .select({
      locale: kbArticleTranslations.locale,
      status: kbArticleTranslations.status,
      aiStatus: kbArticleTranslations.aiStatus,
      publishedVersionId: kbArticleTranslations.publishedVersionId,
      draftVersionId: kbArticleTranslations.draftVersionId,
    })
    .from(kbArticleTranslations)
    .where(eq(kbArticleTranslations.articleId, article.articleId));
  return LOCALES.map((locale) => {
    const row = rows.find((r) => r.locale === locale);
    return {
      locale,
      isOriginal: locale === article.originalLocale,
      status: row ? row.status : null,
      aiStatus: row?.aiStatus ?? null,
      published: Boolean(row?.publishedVersionId),
      draft: Boolean(row?.draftVersionId),
    };
  });
}

export async function articleByIdTx(tx: Tx, articleId: string): Promise<ArticleRow | null> {
  const [row] = await tx
    .select({
      articleId: kbArticles.articleId,
      number: kbArticles.number,
      moduleId: kbArticles.moduleId,
      audience: kbArticles.audience,
      originalLocale: kbArticles.originalLocale,
      status: kbArticles.status,
      ownerId: kbArticles.ownerId,
      isUntrusted: kbArticles.isUntrusted,
    })
    .from(kbArticles)
    .where(eq(kbArticles.articleId, articleId))
    .limit(1);
  return row ?? null;
}

/** Строка языка: есть или создаётся. Опубликованную версию и состояние перевода она не получает (триггер 0071). */
async function ensureLanguageTx(tx: Tx, articleId: string, locale: Locale): Promise<{ draftVersionId: string | null; aiStatus: AiJobStatus | null }> {
  await tx.insert(kbArticleTranslations).values({ articleId, locale }).onConflictDoNothing({ target: [kbArticleTranslations.articleId, kbArticleTranslations.locale] });
  const [row] = await tx
    .select({ draftVersionId: kbArticleTranslations.draftVersionId, aiStatus: kbArticleTranslations.aiStatus })
    .from(kbArticleTranslations)
    .where(and(eq(kbArticleTranslations.articleId, articleId), eq(kbArticleTranslations.locale, locale)));
  return row!;
}

export type StartResult = 'started' | 'exists' | 'no_original' | 'original_locale';

/** "Перевести самому": черновик перевода копией опубликованного оригинала, если черновика ещё нет. */
export async function startManualTranslationTx(tx: Tx, article: ArticleRow, locale: Locale): Promise<StartResult> {
  if (locale === article.originalLocale) return 'original_locale';
  const original = await originalPublishedTx(tx, article);
  if (!original) return 'no_original';
  const row = await ensureLanguageTx(tx, article.articleId, locale);
  if (row.draftVersionId) return 'exists';
  await insertDraftTx(tx, article.articleId, locale, { title: original.title, doc: original.doc, isMachine: false, sourceVersionId: original.versionId });
  return 'started';
}

/** "Перевести с AI": отметка "готовится"; задачу kb.translate слой api ставит после фиксации. */
export async function requestMachineTranslationTx(tx: Tx, article: ArticleRow, locale: Locale): Promise<StartResult> {
  if (locale === article.originalLocale) return 'original_locale';
  if (!(await originalPublishedTx(tx, article))) return 'no_original';
  await ensureLanguageTx(tx, article.articleId, locale);
  await setAiStatusTx(tx, article.articleId, locale, 'pending');
  return 'started';
}

export async function setAiStatusTx(tx: Tx, articleId: string, locale: Locale, status: AiJobStatus): Promise<void> {
  await tx
    .update(kbArticleTranslations)
    .set({ aiStatus: status })
    .where(and(eq(kbArticleTranslations.articleId, articleId), eq(kbArticleTranslations.locale, locale)));
}

export async function aiStatusTx(tx: Tx, articleId: string, locale: Locale): Promise<AiJobStatus | null> {
  const [row] = await tx
    .select({ aiStatus: kbArticleTranslations.aiStatus })
    .from(kbArticleTranslations)
    .where(and(eq(kbArticleTranslations.articleId, articleId), eq(kbArticleTranslations.locale, locale)));
  return row?.aiStatus ?? null;
}

/**
 * Машинный перевод в черновик (система): поверх черновика, если он есть, иначе новый черновик. Текст помечен
 * машинным и помнит версию оригинала, с которой переведён. Опубликованный перевод не меняется до публикации.
 */
export async function writeMachineTranslationTx(tx: Tx, article: ArticleRow, locale: Locale, content: { title: string; doc: SolutionDoc; sourceVersionId: string }): Promise<void> {
  // Пока модель переводила, решение могли снять в архив: состояние статьи читается заново под блокировкой текста
  // статьи, черновик архивного решения не пишется (0057, M6m).
  await lockArticleTx(tx, article.articleId);
  const fresh = await articleByIdTx(tx, article.articleId);
  if (fresh?.status !== 'active') {
    await setAiStatusTx(tx, article.articleId, locale, 'skipped');
    return;
  }
  const row = await ensureLanguageTx(tx, article.articleId, locale);
  if (row.draftVersionId)
    await tx
      .update(kbArticleVersions)
      .set({ title: content.title, doc: content.doc, isMachine: true, sourceVersionId: content.sourceVersionId })
      .where(and(eq(kbArticleVersions.versionId, row.draftVersionId), eq(kbArticleVersions.state, 'draft')));
  else await insertDraftTx(tx, article.articleId, locale, { ...content, isMachine: true });
  await setAiStatusTx(tx, article.articleId, locale, 'ready');
}

/**
 * Блоки оригинала, изменившиеся с той версии, с которой сделан перевод (UX-W-06). Перевод без отметки версии:
 * изменившимся считается всё.
 */
export async function changedSinceTx(tx: Tx, articleId: string, sourceVersionId: string | null, current: SolutionDoc): Promise<string[]> {
  const all = current.blocks.map((block) => block.attrs.id);
  if (!sourceVersionId) return all;
  const [source] = await tx
    .select({ doc: kbArticleVersions.doc })
    .from(kbArticleVersions)
    .where(and(eq(kbArticleVersions.versionId, sourceVersionId), eq(kbArticleVersions.articleId, articleId)))
    .limit(1);
  const parsed = safeParseSolutionDoc(source?.doc);
  return parsed.success ? changedBlockIds(parsed.data, current) : all;
}
