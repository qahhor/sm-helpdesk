import type { SearchHitId } from './types';

// Слияние списков поиска (план W6, решения 6 и 8): прямой запрос по полям со стеммингом и свёрнутый по полям *_fold
// приходят одним многократным поиском, итог сливается RRF: 1/(60 + место) с весом списка. Вес свёрнутого списка 0.7
// (подобран в задаче 9 на наборе 15.4). Чистые функции.

export const RRF_K = 60;

/** Ожидание ответа Typesense по месту вызова, мс (решение 14): дольше, и поиск идёт прежним путём PostgreSQL. */
export const SEARCH_TIMEOUT_MS = { staffQueues: 60, client: 100, directory: 100, suggest: 120, ideas: 120 } as const;

/** Вес свёрнутого списка относительно прямого (решение 8, подбор в задаче 9). */
export const FOLD_WEIGHT = 0.7;

export type RankedList = { hits: readonly SearchHitId[]; weight: number; key?: (id: string) => string };

/** Ключи по убыванию суммы весов RRF; при равенстве порядок первого появления. */
export function mergeRanked(lists: readonly RankedList[], limit = Infinity): string[] {
  const score = new Map<string, number>();
  const first = new Map<string, number>();
  let seen = 0;
  for (const list of lists)
    list.hits.forEach((hit, index) => {
      const key = list.key ? list.key(hit.id) : hit.id;
      score.set(key, (score.get(key) ?? 0) + list.weight / (RRF_K + index + 1));
      if (!first.has(key)) first.set(key, seen++);
    });
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || first.get(a)! - first.get(b)!).slice(0, limit);
}
