import { expect } from 'vitest';

// Пороги по стенным часам (проверка качества, Q10). В интеграционном прогоне они зависят от загрузки машины: сосед по
// CI или параллельная сборка роняли тест без ошибки в коде. Поэтому порог проверяется только в проекте perf
// (pnpm exec vitest run --project perf: база с настройками памяти как в compose.prod.yaml), а интеграционный прогон
// проверяет план запроса и итог, время только печатает при превышении.

/** Проект perf ставит HUB_PERF_ASSERT=1 в tests/perf/global-setup.ts. */
const strict = () => process.env.HUB_PERF_ASSERT === '1';

/** Время не больше предела. Вне проекта perf превышение не роняет тест, а печатается. */
export function expectWithin(ms: number, limitMs: number, what: string): void {
  if (strict()) {
    expect(ms, what).toBeLessThan(limitMs);
    return;
  }
  if (ms >= limitMs) process.stdout.write(`время (не проверяется вне проекта perf): ${what}: ${Math.round(ms)} мс при пределе ${limitMs}\n`);
}
