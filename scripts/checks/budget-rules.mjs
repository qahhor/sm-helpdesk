// Бюджет скриптов первого экрана (ТЗ, раздел 8.9): предел и подсчёт. Используют pnpm budget
// (scripts/checks/bundle-budget.mjs) и браузерный тест главной кабинета (tests/e2e/budget.spec.ts).

export const BUDGET_BYTES = 170 * 1024;

/**
 * Сумма сжатого размера скриптов. Повторные загрузки одного адреса считаются один раз.
 * @param {{ url: string; resourceType: string; encodedBytes: number }[]} responses
 * @returns {number}
 */
export function sumScriptBytes(responses) {
  /** @type {Map<string, number>} */
  const scripts = new Map();
  for (const response of responses)
    if (response.resourceType === 'script') scripts.set(response.url, response.encodedBytes);
  return [...scripts.values()].reduce((sum, bytes) => sum + bytes, 0);
}
