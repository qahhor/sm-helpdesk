import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import type { KbAudience } from '../pref';
import { kbArticles, kbArticleTranslations, kbArticleVersions, kbPublished } from '../schema';
import type { SolutionDoc } from '../doc-schema';

// Модуль hdk, слой core: статьи и копия для читателей внутри withActor (план M5, задача 2). Права проверяет слой api
// и ещё раз база (политики 0071): черновик пишут роли черновиков, копию hdk_published только публикация (задача 4).

export type NewDraft = { locale: Locale; title: string; audience: KbAudience; moduleId: string | null; ownerId: string | null; doc: SolutionDoc };

/** Новая статья с первым черновиком на языке оригинала и строкой этого языка. */
export async function createDraftTx(tx: Tx, input: NewDraft): Promise<{ articleId: string; number: number; versionId: string }> {
  const [article] = await tx
    .insert(kbArticles)
    .values({ audience: input.audience, moduleId: input.moduleId, ownerId: input.ownerId, originalLocale: input.locale })
    .returning({ articleId: kbArticles.articleId, number: kbArticles.number });
  const [version] = await tx
    .insert(kbArticleVersions)
    .values({ articleId: article!.articleId, locale: input.locale, number: 1, title: input.title, doc: input.doc })
    .returning({ versionId: kbArticleVersions.versionId });
  await tx.insert(kbArticleTranslations).values({ articleId: article!.articleId, locale: input.locale, draftVersionId: version!.versionId, status: 'reviewed' });
  return { articleId: article!.articleId, number: article!.number, versionId: version!.versionId };
}

export type PublishedRow = typeof kbPublished.$inferSelect;

/** Строка копии по номеру и языку. Что из неё видно актору, решает политика: клиенту только audience = clients. */
export async function publishedByNumberTx(tx: Tx, number: number, locale: Locale): Promise<PublishedRow | null> {
  const [row] = await tx
    .select()
    .from(kbPublished)
    .where(and(eq(kbPublished.articleNumber, number), eq(kbPublished.locale, locale)))
    .limit(1);
  return row ?? null;
}
