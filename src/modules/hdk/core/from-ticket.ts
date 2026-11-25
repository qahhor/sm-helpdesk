import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { kbArticles, kbArticleSources, kbArticleVersions } from '../schema';

// Модуль hdk, слой core: решение из обращения (ТЗ FR-SOL-02, 03, UX-W-09, сценарий S5; план M5, задача 7, решение 15).
// Источник решения (обращение) лежит в hdk_article_sources: его видят только сотрудники.

export async function insertSourceTx(tx: Tx, input: { orgId: string; articleId: string; ticketId: string }): Promise<void> {
  await tx.insert(kbArticleSources).values(input);
}

/** Решение, выросшее из обращения (первое по времени): номер для ссылки на странице обращения. */
export async function articleOfTicketTx(tx: Tx, ticketId: string): Promise<number | null> {
  const [row] = await tx
    .select({ number: kbArticles.number })
    .from(kbArticleSources)
    .innerJoin(kbArticles, eq(kbArticles.articleId, kbArticleSources.articleId))
    .where(eq(kbArticleSources.ticketId, ticketId))
    .orderBy(asc(kbArticleSources.createdOn))
    .limit(1);
  return row?.number ?? null;
}

export async function sourceTicketIdsTx(tx: Tx, articleId: string): Promise<string[]> {
  const rows = await tx.select({ ticketId: kbArticleSources.ticketId }).from(kbArticleSources).where(eq(kbArticleSources.articleId, articleId)).orderBy(asc(kbArticleSources.createdOn));
  return rows.map((row) => row.ticketId);
}

/**
 * Черновик языка, который ещё никто не правил (время изменения равно времени создания): только в него задача
 * черновика кладёт текст модели. Сотрудник начал писать раньше модели: null, его текст не затирается.
 */
export async function untouchedDraftTx(tx: Tx, articleId: string, locale: Locale): Promise<{ versionId: string; doc: unknown } | null> {
  const [row] = await tx
    .select({ versionId: kbArticleVersions.versionId, doc: kbArticleVersions.doc })
    .from(kbArticleVersions)
    .where(
      and(
        eq(kbArticleVersions.articleId, articleId),
        eq(kbArticleVersions.locale, locale),
        eq(kbArticleVersions.state, 'draft'),
        sql`${kbArticleVersions.modifiedOn} = ${kbArticleVersions.createdOn}`,
      ),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}
