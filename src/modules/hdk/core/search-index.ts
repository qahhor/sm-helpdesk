import 'server-only';
import { and, eq, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { kbArticles, kbDeflectionEvents, kbPublished, kbSearchDocuments } from '../schema';

// Модуль hdk, слой core: поисковый индекс подсказки (ТЗ 10.4; план M5, задача 9, решения 5 и 11). Строка на пару
// "решение + язык", снятая с копии для читателей hdk_published: другого источника текста у индекса нет, поэтому текст
// обращения в индекс не попадает никогда (сотрудник может перенести его в решение только публикацией). Аудитория
// строки повторяет копию (составной внешний ключ с каскадом): решение "только через сотрудника" остаётся в индексе
// для поиска сотрудника (FR-AG-05), но клиент его не видит (политика RLS). Архив удаляет копию, а с ней строку индекса.
// Вектор считается отдельно, вне транзакции: ожидание сервиса векторов не держит соединение и блокировки.

/** Сколько знаков текста уходит в модель векторов: BGE-M3 обрезает вход сама, лишнее не нужно передавать. */
const EMBED_TEXT_MAX = 8000;

export type PendingEmbedding = { searchDocumentId: string; title: string; bodyText: string };

export const embeddingText = (row: { title: string; bodyText: string }): string => `${row.title}\n${row.bodyText}`.slice(0, EMBED_TEXT_MAX);

/**
 * Приводит строки индекса статьи к её копиям для читателей: вставка и обновление по языкам, лишние языки удаляются,
 * у архивной и неопубликованной статьи строк нет. Вектор строки с изменившимся текстом сбрасывается. Возвращает
 * строки без вектора.
 */
export async function syncArticleIndexTx(tx: Tx, articleId: string): Promise<{ indexed: number; removed: number; pending: PendingEmbedding[] }> {
  const [article] = await tx.select({ status: kbArticles.status, moduleId: kbArticles.moduleId }).from(kbArticles).where(eq(kbArticles.articleId, articleId)).limit(1);
  const copies =
    article?.status === 'active'
      ? await tx
          .select({ publishedId: kbPublished.publishedId, locale: kbPublished.locale, audience: kbPublished.audience, type: kbPublished.type, title: kbPublished.title, bodyText: kbPublished.bodyText })
          .from(kbPublished)
          .where(eq(kbPublished.articleId, articleId))
      : [];
  const ofArticle = and(eq(kbSearchDocuments.kind, 'article'), eq(kbSearchDocuments.refId, articleId));
  const removed = await tx
    .delete(kbSearchDocuments)
    .where(copies.length === 0 ? ofArticle : and(ofArticle, notInArray(kbSearchDocuments.locale, copies.map((c) => c.locale))))
    .returning({ id: kbSearchDocuments.searchDocumentId });
  for (const copy of copies) {
    const row = {
      publishedId: copy.publishedId,
      moduleId: article?.moduleId ?? null,
      articleType: copy.type,
      audience: copy.audience,
      title: copy.title,
      bodyText: copy.bodyText,
    };
    await tx
      .insert(kbSearchDocuments)
      .values({ kind: 'article', refId: articleId, locale: copy.locale, ...row })
      .onConflictDoUpdate({
        target: [kbSearchDocuments.kind, kbSearchDocuments.refId, kbSearchDocuments.locale],
        set: {
          ...row,
          // Вектор прежнего текста не подходит новому: строка ждёт нового вектора, полнотекстовый поиск работает сразу.
          embedding: sql`case when ${kbSearchDocuments.title} = excluded.title and ${kbSearchDocuments.bodyText} = excluded.body_text then ${kbSearchDocuments.embedding} end`,
        },
      });
  }
  const pending =
    copies.length === 0
      ? []
      : await tx
          .select({ searchDocumentId: kbSearchDocuments.searchDocumentId, title: kbSearchDocuments.title, bodyText: kbSearchDocuments.bodyText })
          .from(kbSearchDocuments)
          .where(and(ofArticle, isNull(kbSearchDocuments.embedding)));
  return { indexed: copies.length, removed: removed.length, pending };
}

/** Записывает вектор, только если текст строки не изменился, пока вектор считался. */
export async function writeEmbeddingTx(tx: Tx, row: PendingEmbedding, vector: readonly number[]): Promise<boolean> {
  const updated = await tx
    .update(kbSearchDocuments)
    .set({ embedding: [...vector] })
    .where(and(eq(kbSearchDocuments.searchDocumentId, row.searchDocumentId), eq(kbSearchDocuments.title, row.title), eq(kbSearchDocuments.bodyText, row.bodyText)))
    .returning({ id: kbSearchDocuments.searchDocumentId });
  return updated.length > 0;
}

/**
 * Статьи, индекс которых расходится с копиями для читателей: опубликованный язык без строки индекса, строка без
 * вектора, строка с другим текстом, другим модулем статьи, типом или аудиторией (всё, что syncArticleIndexTx копирует
 * в строку; повторная проверка M5, 0057). Для ночной сверки kb.reconcile.
 */
export async function articlesOutOfSyncTx(tx: Tx, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ article_id: string }>(sql`
    select distinct p.article_id
      from ${kbPublished} p
      join ${kbArticles} a on a.article_id = p.article_id
      left join ${kbSearchDocuments} d on d.kind = 'article' and d.ref_id = p.article_id and d.locale = p.locale
     where d.search_document_id is null or d.embedding is null or d.title <> p.title or d.body_text <> p.body_text
        or d.published_id <> p.published_id or d.module_id is distinct from a.module_id or d.article_type <> p.type
        or d.audience <> p.audience
     limit ${limit}`);
  return rows.rows.map((r) => r.article_id);
}

/** Исходы подсказки хранятся 13 месяцев (план M5, решение 12). */
export async function cleanupDeflectionsTx(tx: Tx, now: Date): Promise<number> {
  const removed = await tx
    .delete(kbDeflectionEvents)
    .where(lt(kbDeflectionEvents.createdOn, sql`${now.toISOString()}::timestamptz - interval '13 months'`))
    .returning({ id: kbDeflectionEvents.deflectionEventId });
  return removed.length;
}

