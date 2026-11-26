import { expect, test } from 'vitest';
import { devOnlyNames, envVarsMissingInLaunch, launchGaps } from '../../../scripts/checks/env-example.mjs';

// Памятка запуска сквозь все вехи (план подготовки M9, задача 8): каждая переменная схемы src/env.ts и каждая
// переменная .env.example названа в docs/runbooks/launch.md; переменная только для разработки отмечена в .env.example
// строкой "# только разработка" над ней.

test('имя ищется целым словом: AI_MODEL не засчитывает AI_MODEL_FAST', () => {
  expect(launchGaps(['AI_MODEL_FAST', 'HUB_URL'], '`AI_MODEL` и `HUB_URL`', new Set())).toEqual(['AI_MODEL_FAST']);
});

test('переменная, отмеченная в .env.example "только разработка", памятке не нужна', () => {
  expect(launchGaps(['PG_IMAGE', 'HUB_URL'], 'HUB_URL', new Set(['PG_IMAGE']))).toEqual([]);
});

test('каждая переменная src/env.ts и .env.example названа в памятке запуска', async () => {
  expect(await envVarsMissingInLaunch()).toEqual([]);
});

test('отметка "только разработка" действует только на следующую переменную (проверка M9, M5)', () => {
  const example = ['# только разработка: пароль контейнера', '# пояснение', 'POSTGRES_PASSWORD=x', '# Образ базы', '# PG_IMAGE=y', 'HUB_URL=z'].join('\n');
  expect([...devOnlyNames(example)]).toEqual(['POSTGRES_PASSWORD']);
});
