import 'server-only';
import { and, asc, gt, inArray, notInArray, sql } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { foldText, HIDDEN_IDEA_STATUSES, localeField, type SearchDocument, TEXT_LIMITS } from '@/modules/hdc/api';
import { ideas, ideaTranslations } from '../schema';

// Модуль hdi, слой api: документы идей для индекса поиска (план W6, решение 1). Только опубликованные идеи (решение 2
// вехи M7): на модерации, отклонённая и объединённая в индекс не попадают и снимаются из него. Строка на язык текста,
// который видят клиенты (оригинал и переводы, кроме устаревших и отклонённых сверкой). Без автора и организации.

/** Тексты, которых клиенты не видят (как на доске, core/board.ts). */
const HIDDEN_TEXT = ['outdated', 'rejected'] as const;

export async function buildIdeaDocs(system: SystemActor, ideaIds: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(ideaIds.map((id) => [id, []]));
  if (ideaIds.length === 0) return out;
  const rows = await withActor(system, (tx) =>
    tx
      .select({
        ideaId: ideas.ideaId,
        status: ideas.status,
        moduleId: ideas.moduleId,
        locale: ideaTranslations.locale,
        title: ideaTranslations.title,
        body: sql<string>`left(${ideaTranslations.body}, ${TEXT_LIMITS.ideaBody})`,
        version: sql<string>`(extract(epoch from greatest(${ideas.modifiedOn}, ${ideaTranslations.modifiedOn})) * 1000000)::bigint::text`,
      })
      .from(ideas)
      .innerJoin(ideaTranslations, sql`${ideaTranslations.ideaId} = ${ideas.ideaId}`)
      .where(and(inArray(ideas.ideaId, [...ideaIds]), notInArray(ideas.status, [...HIDDEN_IDEA_STATUSES]), notInArray(ideaTranslations.status, [...HIDDEN_TEXT]))),
  );
  for (const row of rows)
    out.get(row.ideaId)?.push({
      id: `${row.ideaId}_${row.locale}`,
      idea_id: row.ideaId,
      locale: row.locale,
      status: row.status,
      ...(row.moduleId ? { module_id: row.moduleId } : {}),
      [localeField('title', row.locale)]: row.title,
      [localeField('body', row.locale)]: row.body,
      title_fold: foldText(row.title),
      body_fold: foldText(row.body),
      version: Number(row.version),
    });
  return out;
}

export async function pageIdeaIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const rows = await withActor(system, (tx) =>
    tx
      .select({ id: ideas.ideaId })
      .from(ideas)
      .where(after ? gt(ideas.ideaId, after) : undefined)
      .orderBy(asc(ideas.ideaId))
      .limit(limit),
  );
  return rows.map((r) => r.id);
}
