import { REVIEW_MIN_OUTCOMES, REVIEW_NOT_HELPED_PERCENT } from './pref';

// Модуль hdk: список на пересмотр (FR-SOL-19; план M5, решение 18). Чистая функция; то же правило в SQL списка
// решений (core/editor.ts, listArticlesTx): доля "не помогло" выше 40% при не менее чем 10 исходах.

/** Доля "не помогло" среди исходов в процентах с одним знаком; исходов нет: null. */
export function notHelpedPercent(counts: { helped: number; notHelped: number }): number | null {
  const total = counts.helped + counts.notHelped;
  return total > 0 ? Math.round((counts.notHelped / total) * 1000) / 10 : null;
}

/** Решение на пересмотр: исходов не меньше 10 и "не помогло" строго больше 40% (целочисленное сравнение, без округления). */
export function needsReview(counts: { helped: number; notHelped: number }): boolean {
  const total = counts.helped + counts.notHelped;
  return total >= REVIEW_MIN_OUTCOMES && counts.notHelped * 100 > REVIEW_NOT_HELPED_PERCENT * total;
}
