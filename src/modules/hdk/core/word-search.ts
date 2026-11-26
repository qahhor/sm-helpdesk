import 'server-only';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { filterValues, FOLD_WEIGHT, foldText, localizedFields, mergeRanked, SEARCH_TIMEOUT_MS, searchAs, STOPWORD_SETS, type SearchHitId } from '@/modules/hdc/api';
import { SEARCH_LIST_LIMIT } from '../pref';

// Модуль hdk, слой core: слова подсказки решений и похожих идей из Typesense (план W6, задачи 6 и 7, решение 6).
// Прямой запрос по полям языков со стеммингом и свёрнутый по полям *_fold одним многократным поиском, слияние RRF.
// Результат: документы <объект, язык> по месту и признак "все слова". Смысловой список и итоговый ранг остаются в SQL
// (hybridSearchTx, ranking.ts), строки читаются под RLS актора. null: Typesense выключен или не ответил.

export type WordHit = { refId: string; locale: Locale; allWords: boolean };

/** Слов в запросе: так же, как FR-SOL-09 считает описание проблемы. */
const wordsOf = (text: string) => text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;

export async function typesenseWords(
  actor: ClientActor | StaffActor,
  kind: 'solutions' | 'ideas',
  text: string,
  locales: readonly Locale[],
): Promise<WordHit[] | null> {
  const folded = foldText(text);
  const filterBy = `locale:=${filterValues(locales)}`;
  const common = { collection: kind, filterBy, perPage: SEARCH_LIST_LIMIT, prefix: true, splitJoinTokens: 'fallback' as const, stopwords: STOPWORD_SETS };
  const searches = [
    { spec: { ...common, q: text, queryBy: [...localizedFields('title'), ...localizedFields('body')], queryByWeights: [3, 3, 3, 1, 1, 1] }, weight: 1 },
    ...(folded ? [{ spec: { ...common, q: folded, queryBy: ['title_fold', 'body_fold'], queryByWeights: [3, 1] }, weight: FOLD_WEIGHT }] : []),
  ];
  const res = await searchAs(actor, kind, searches.map((s) => s.spec), { timeoutMs: kind === 'solutions' ? SEARCH_TIMEOUT_MS.suggest : SEARCH_TIMEOUT_MS.ideas });
  if (res.kind === 'fallback') return null;
  const words = wordsOf(text);
  const every = new Set<string>();
  const all = (hits: readonly SearchHitId[]) => hits.forEach((h) => words >= 2 && h.tokensMatched >= words && every.add(h.id));
  res.results.forEach((r) => all(r.hits));
  return mergeRanked(res.results.map((r, i) => ({ hits: r.hits, weight: searches[i]!.weight })), SEARCH_LIST_LIMIT).flatMap((id) => {
    const cut = id.lastIndexOf('_');
    const locale = id.slice(cut + 1) as Locale;
    return cut > 0 && locales.includes(locale) ? [{ refId: id.slice(0, cut), locale, allWords: every.has(id) }] : [];
  });
}
