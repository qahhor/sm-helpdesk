import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type Actor, withActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { kbArticles, kbPublished } from '../schema';

// Модуль hdk, слой api: ссылки на решения для других модулей (план M5c, задачи 2 и 4: обходной путь известной
// проблемы). Клиенту ссылка на решение отдаётся только из hdk_published и только для решений с audience = clients:
// так её отбирает и политика базы, и этот запрос.

export type SolutionRef = { articleId: string; number: number; slug: string; title: string };

/** Действующее решение по номеру (сотрудник выбирает обходной путь); нет такого: null. */
export async function solutionIdByNumberTx(tx: Tx, number: number): Promise<string | null> {
  const [row] = await tx.select({ articleId: kbArticles.articleId }).from(kbArticles).where(and(eq(kbArticles.number, number), eq(kbArticles.status, 'active'))).limit(1);
  return row?.articleId ?? null;
}

/** Номера решений по идентификаторам: карточка проблемы у сотрудника. */
export async function solutionNumbersTx(tx: Tx, articleIds: readonly string[]): Promise<Map<string, number>> {
  if (articleIds.length === 0) return new Map();
  const rows = await tx.select({ articleId: kbArticles.articleId, number: kbArticles.number }).from(kbArticles).where(inArray(kbArticles.articleId, [...articleIds]));
  return new Map(rows.map((r) => [r.articleId, r.number]));
}

/**
 * Опубликованные для клиентов решения по идентификаторам на языке читателя, иначе на языке оригинала. Черновик,
 * архивное и внутреннее решение не попадают в ответ: обходного пути у клиента тогда нет.
 */
export async function clientSolutionRefs(actor: Actor, input: { articleIds: readonly string[]; locale: Locale }): Promise<Map<string, SolutionRef>> {
  const ids = [...new Set(input.articleIds)];
  if (ids.length === 0) return new Map();
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ articleId: kbPublished.articleId, number: kbPublished.articleNumber, slug: kbPublished.slug, title: kbPublished.title, locale: kbPublished.locale, originalLocale: kbPublished.originalLocale })
      .from(kbPublished)
      .where(and(inArray(kbPublished.articleId, ids), eq(kbPublished.audience, 'clients'))),
  );
  const refs = new Map<string, SolutionRef>();
  for (const id of ids) {
    const own = rows.filter((r) => r.articleId === id);
    const row = own.find((r) => r.locale === input.locale) ?? own.find((r) => r.locale === r.originalLocale) ?? own[0];
    if (row) refs.set(id, { articleId: id, number: row.number, slug: row.slug, title: row.title });
  }
  return refs;
}
