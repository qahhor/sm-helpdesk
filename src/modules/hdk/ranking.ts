import type { Locale } from '@/i18n/locales';
import type { SearchHit } from './core/search';
import { MODULE_BOOST, SEMANTIC_STRONG_DISTANCE, SUGGEST_MAX, type KbAudience } from './pref';

// Отбор подсказки (ТЗ 11.6, FR-SOL-08, 09, 10; план M5, решение 17). Чистая функция без базы.
// Точное совпадение сигнатуры показывается всегда и первым. Остальное только уверенное: документ нашёлся хотя бы в
// двух списках из трёх, или в нём есть все слова запроса (не меньше двух), или смысловое расстояние не больше 0.25.
// Решения того же модуля получают множитель 1.1. Одно решение показывается один раз: из его языков берётся строка с
// большей оценкой, при равной язык, стоящий раньше в цепочке. Не больше трёх.

export type ExactHit = { articleId: string; locale: Locale; moduleId: string | null; audience: KbAudience; number: number; slug: string; title: string };
export type RankedHit = ExactHit & { exact: boolean; score: number };

export const isConfident = (hit: SearchHit): boolean => hit.lists >= 2 || hit.allWords || (hit.distance !== null && hit.distance <= SEMANTIC_STRONG_DISTANCE);

export function rankHits(hits: readonly SearchHit[], opts: { exact: ExactHit | null; moduleId: string | null; locales: readonly Locale[]; limit?: number }): RankedHit[] {
  const order = (locale: Locale) => {
    const at = opts.locales.indexOf(locale);
    return at < 0 ? opts.locales.length : at;
  };
  const best = new Map<string, RankedHit>();
  for (const hit of hits) {
    if (hit.articleId === opts.exact?.articleId || !isConfident(hit)) continue;
    const score = hit.rrf * (opts.moduleId !== null && hit.moduleId === opts.moduleId ? MODULE_BOOST : 1);
    const ranked: RankedHit = { articleId: hit.articleId, locale: hit.locale, moduleId: hit.moduleId, audience: hit.audience, number: hit.number, slug: hit.slug, title: hit.title, exact: false, score };
    const prev = best.get(hit.articleId);
    if (!prev || score > prev.score || (score === prev.score && order(hit.locale) < order(prev.locale))) best.set(hit.articleId, ranked);
  }
  const rest = [...best.values()].sort((a, b) => b.score - a.score || a.number - b.number);
  const head: RankedHit[] = opts.exact ? [{ ...opts.exact, exact: true, score: Number.POSITIVE_INFINITY }] : [];
  return [...head, ...rest].slice(0, opts.limit ?? SUGGEST_MAX);
}
