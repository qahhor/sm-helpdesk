import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Собранный портал работает из .next/standalone (локально) и из /app (образ Docker): оба места должны
// получить каталог content/, иначе утверждённая политика обработки данных не включится (решение 0017).

test('образ и локальный запуск собранного портала получают каталог content', () => {
  expect(readFileSync('Dockerfile', 'utf8')).toMatch(/^COPY content \.\/content$/m);
  expect(readFileSync('scripts/start-standalone.mjs', 'utf8')).toMatch(/join\(root, 'content'\)/);
});
