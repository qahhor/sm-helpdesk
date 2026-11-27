import { CANDIDATE_RETURN_SOURCES } from '../pref';

// Модуль hda, кандидаты: решение о склейке (ТЗ FR-CAND-02, 03, 05; план M5c, задача 9, решение 28). Чистые функции без
// базы: сходство считает вызывающий (косинусное сходство векторов BGE-M3), здесь только правило.
//   1. Похоже на опубликованное решение любой аудитории не ниже порога published: кандидата нет, решению
//      "пригодилось сотрудникам" (FR-CAND-03).
//   2. Иначе похоже на кандидата в статусе new или rejected не ниже порога merge: источник добавляется к нему.
//   3. Иначе новый кандидат.

export type MergeDecision = { kind: 'useful'; articleId: string } | { kind: 'merge'; candidateId: string } | { kind: 'create' };

export function candidateMergeDecision(input: {
  publishedBest: { articleId: string; similarity: number } | null;
  candidateBest: { id: string; status: 'new' | 'rejected'; similarity: number } | null;
  thresholds: { published: number; merge: number };
}): MergeDecision {
  if (input.publishedBest && input.publishedBest.similarity >= input.thresholds.published) return { kind: 'useful', articleId: input.publishedBest.articleId };
  if (input.candidateBest && input.candidateBest.similarity >= input.thresholds.merge) return { kind: 'merge', candidateId: input.candidateBest.id };
  return { kind: 'create' };
}

/** Отклонённый кандидат возвращается в очередь, когда после отклонения добавилось не меньше пяти источников (FR-CAND-05). */
export function returnsFromRejected(input: { sourceCount: number; rejectedAtSourceCount: number | null }): boolean {
  return input.rejectedAtSourceCount !== null && input.sourceCount - input.rejectedAtSourceCount >= CANDIDATE_RETURN_SOURCES;
}

/** Число различных организаций среди источников. */
export function distinctOrgCount(sources: readonly { orgId: string }[]): number {
  return new Set(sources.map((s) => s.orgId)).size;
}
