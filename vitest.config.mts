import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Настоящий пакет бросает ошибку вне сервера Next.js.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Одна база на весь прогон: контейнер поднимает globalSetup, файлы идут по очереди.
          globalSetup: ['tests/integration/setup/global-setup.ts'],
          setupFiles: ['tests/integration/setup/each.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Проверочный набор поиска (ТЗ 15.4; план M5, задача 11): pnpm eval:search. Не входит в CI: отчёт, а не проверка.
        extends: true,
        test: {
          name: 'eval',
          environment: 'node',
          include: ['tests/eval/**/*.test.ts'],
          globalSetup: ['tests/integration/setup/global-setup.ts'],
          setupFiles: ['tests/integration/setup/each.ts'],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 900_000,
        },
      },
      {
        // Замеры под нагрузкой (FR-SOL-14): не входят в CI, запуск pnpm exec vitest run --project perf.
        extends: true,
        test: {
          name: 'perf',
          environment: 'node',
          // Вместе с замерами идут интеграционные файлы с порогами по времени (проверка качества, Q10): в проекте
          // integration их пороги только печатаются, здесь проверяются.
          include: [
            'tests/perf/**/*.test.ts',
            'tests/integration/hda-agent-plans.test.ts',
            'tests/integration/hdk-suggest.test.ts',
            'tests/integration/hda-code-review.test.ts',
            'tests/integration/metrics.test.ts',
            'tests/integration/hdi-notices.test.ts',
          ],
          globalSetup: ['tests/perf/global-setup.ts'],
          setupFiles: ['tests/integration/setup/each.ts'],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 900_000,
        },
      },
    ],
  },
});
