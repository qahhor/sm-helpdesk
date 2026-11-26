import 'server-only';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { FOLD_WEIGHT, foldText, localizedFields, mergeRanked, SEARCH_TIMEOUT_MS, searchAs } from '@/modules/hdc/api';

// Модуль hdi, слой core: поиск по доске и у сотрудника через Typesense (план W6, задача 7). Коллекция hub_ideas держит
// только опубликованные идеи без автора и организации; из ответа берутся идентификаторы идей, карточки читаются под
// актором, как раньше. null: Typesense выключен или не ответил, вызывающий ищет прежним containsText.

const LIMIT = 250;

export async function ideaTextIds(actor: ClientActor | StaffActor, q: string): Promise<string[] | null> {
  const folded = foldText(q);
  const searches = [
    { spec: { collection: 'ideas' as const, q, queryBy: [...localizedFields('title'), ...localizedFields('body')], queryByWeights: [3, 3, 3, 1, 1, 1], prefix: true, perPage: LIMIT, groupBy: 'idea_id' }, weight: 1 },
    ...(folded ? [{ spec: { collection: 'ideas' as const, q: folded, queryBy: ['title_fold', 'body_fold'], queryByWeights: [3, 1], prefix: true, perPage: LIMIT, groupBy: 'idea_id' }, weight: FOLD_WEIGHT }] : []),
  ];
  const res = await searchAs(actor, 'ideas', searches.map((s) => s.spec), { timeoutMs: SEARCH_TIMEOUT_MS.ideas });
  if (res.kind === 'fallback') return null;
  // Документ <идея>_<язык>: идея до последнего знака _.
  return mergeRanked(res.results.map((r, i) => ({ hits: r.hits, weight: searches[i]!.weight, key: (id: string) => id.slice(0, id.lastIndexOf('_')) })), LIMIT);
}
