import 'server-only';
import { eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { HdkError } from '../error';
import { kbArticles, kbArticleSources } from '../schema';

// Модуль hdk, слой api: похожие опубликованные решения для кандидатов (план M5c, задача 9, решение 28; FR-CAND-03).
// Сходство считается по векторам поискового индекса hdk_search_documents (только опубликованное, любой аудитории):
// кандидат, похожий на решение, кандидатом не становится, а решению растёт счётчик "пригодилось сотрудникам". Узкий
// файл для фонового процесса. Только система и сотрудник: клиенту функции не даны.

const vectorInput = z.array(z.number().finite()).length(1024);

function assertInternal(actor: SystemActor | StaffActor): void {
  if (actor.type !== 'system' && actor.type !== 'staff') throw new HdkError('forbidden');
}

/** Ближайшее опубликованное решение по косинусному сходству (1 - расстояние pgvector). Индекс пуст: null. */
export async function nearestPublished(actor: SystemActor | StaffActor, input: { vector: readonly number[] }): Promise<{ articleId: string; similarity: number } | null> {
  assertInternal(actor);
  const vector = JSON.stringify(vectorInput.parse(input.vector));
  const rows = await withActor(actor, (tx) =>
    tx.execute<{ ref_id: string; similarity: number }>(sql`
      select d.ref_id, 1 - (d.embedding <=> ${vector}::vector) as similarity
        from hdk_search_documents d
       where d.kind = 'article' and d.embedding is not null
       order by d.embedding <=> ${vector}::vector
       limit 1`),
  );
  const row = rows.rows[0];
  return row ? { articleId: row.ref_id, similarity: Number(row.similarity) } : null;
}

/** "Пригодилось сотрудникам" (FR-CAND-03, 04): счётчик решения растёт на by. */
export async function bumpStaffUseful(actor: SystemActor | StaffActor, input: { articleId: string; by?: number }): Promise<void> {
  assertInternal(actor);
  const data = z.strictObject({ articleId: z.uuid(), by: z.int().positive().max(10_000).default(1) }).parse(input);
  await withActor(actor, (tx) =>
    tx
      .update(kbArticles)
      .set({ staffUsefulCount: sql`${kbArticles.staffUsefulCount} + ${data.by}` })
      .where(eq(kbArticles.articleId, data.articleId)),
  );
}

/** Обращения из списка, которые уже стали источником решения (hdk_article_sources): кандидатом они не становятся. */
export async function ticketsWithSolutionSource(actor: SystemActor, ticketIds: readonly string[]): Promise<Set<string>> {
  assertInternal(actor);
  const ids = z.array(z.uuid()).max(1000).parse([...ticketIds]);
  if (ids.length === 0) return new Set();
  const rows = await withActor(actor, (tx) => tx.select({ ticketId: kbArticleSources.ticketId }).from(kbArticleSources).where(inArray(kbArticleSources.ticketId, ids)));
  return new Set(rows.map((r) => r.ticketId));
}
