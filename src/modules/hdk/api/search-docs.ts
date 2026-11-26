import 'server-only';
import { asc, gt, inArray, sql } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { type CurationItem, foldText, localeField, type SearchDocument, TEXT_LIMITS } from '@/modules/hdc/api';
import { kbPublished } from '../schema';

// Модуль hdk, слой api: документы решений для индекса поиска (план W6, решение 1). Единственный источник текста это
// hdk_published (правило CLAUDE.md "текст статьи клиенту только из kb_published"): черновики, версии и переводы на
// проверке в индекс не попадают. Строка на решение и язык, идентификатор <решение>_<язык>. Аудитория в документе:
// ключ клиента с областью отбирает только clients. Архив удаляет копии, и документ уходит из индекса.

export async function buildSolutionDocs(system: SystemActor, articleIds: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(articleIds.map((id) => [id, []]));
  if (articleIds.length === 0) return out;
  const rows = await withActor(system, (tx) =>
    tx
      .select({
        articleId: kbPublished.articleId,
        locale: kbPublished.locale,
        audience: kbPublished.audience,
        moduleIds: kbPublished.moduleIds,
        title: kbPublished.title,
        body: sql<string>`left(${kbPublished.bodyText}, ${TEXT_LIMITS.solutionBody})`,
        version: sql<string>`(extract(epoch from ${kbPublished.modifiedOn}) * 1000000)::bigint::text`,
      })
      .from(kbPublished)
      .where(inArray(kbPublished.articleId, [...articleIds])),
  );
  for (const row of rows)
    out.get(row.articleId)?.push({
      id: `${row.articleId}_${row.locale}`,
      article_id: row.articleId,
      locale: row.locale,
      audience: row.audience,
      ...(row.moduleIds.length > 0 ? { module_ids: row.moduleIds } : {}),
      [localeField('title', row.locale)]: row.title,
      [localeField('body', row.locale)]: row.body,
      title_fold: foldText(row.title),
      body_fold: foldText(row.body),
      version: Number(row.version),
    });
  return out;
}

export async function pageSolutionIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const rows = await withActor(system, (tx) =>
    tx
      .selectDistinct({ id: kbPublished.articleId })
      .from(kbPublished)
      .where(after ? gt(kbPublished.articleId, after) : undefined)
      .orderBy(asc(kbPublished.articleId))
      .limit(limit),
  );
  return rows.map((r) => r.id);
}

/**
 * Правила курирования администратора (решение 0070, пункт 4) в документы: по номеру решения берётся опубликованная
 * копия на языке оригинала. Нет копии (черновик, архив): правило не уходит. Внутреннее решение уходит, но клиенту
 * его не отдаёт ключ с областью (filter_curated_hits: true).
 */
export async function resolveCurations(system: SystemActor, rules: readonly { id: string; query: string; match: 'exact' | 'contains'; articleNumber: number; position: number }[]): Promise<CurationItem[]> {
  if (rules.length === 0) return [];
  const rows = await withActor(system, (tx) =>
    tx
      .select({ number: kbPublished.articleNumber, articleId: kbPublished.articleId, locale: kbPublished.locale, original: kbPublished.originalLocale })
      .from(kbPublished)
      .where(inArray(kbPublished.articleNumber, rules.map((r) => r.articleNumber))),
  );
  const docOf = new Map<number, string>();
  for (const row of rows) if (row.locale === row.original || !docOf.has(row.number)) docOf.set(row.number, `${row.articleId}_${row.locale}`);
  return rules.flatMap((rule) => {
    const doc = docOf.get(rule.articleNumber);
    return doc ? [{ id: rule.id, query: rule.query, match: rule.match, includes: [{ id: doc, position: rule.position }] }] : [];
  });
}
