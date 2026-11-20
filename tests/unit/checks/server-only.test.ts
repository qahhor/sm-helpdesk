import { expect, test } from 'vitest';
import { findMissingServerOnly, requiresServerOnly } from '../../../scripts/checks/server-only.mjs';

test('файл окружения и файлы базы обязаны начинаться с server-only', () => {
  expect(requiresServerOnly('src/env.ts')).toBe(true);
  expect(requiresServerOnly('src/db/client.ts')).toBe(true);
  expect(requiresServerOnly('src/modules/hdt/core.ts')).toBe(true);
  expect(requiresServerOnly('src/modules/hdt/api.ts')).toBe(true);
  expect(requiresServerOnly('src/modules/hdt/util.ts')).toBe(false);
  expect(requiresServerOnly('src/ui/Button.tsx')).toBe(false);
});

test('отсутствие импорта находится', () => {
  expect(findMissingServerOnly('src/env.ts', "import { z } from 'zod';")).toBe(true);
});

test('импорт первой строкой проходит', () => {
  expect(findMissingServerOnly('src/env.ts', "import 'server-only';\nimport { z } from 'zod';")).toBe(false);
  expect(findMissingServerOnly('src/db/client.ts', '// клиент базы\nimport "server-only";\n')).toBe(false);
});

test('импорт после другого кода не засчитывается', () => {
  expect(findMissingServerOnly('src/env.ts', "import { z } from 'zod';\nimport 'server-only';")).toBe(true);
});

test('файлы вне области не проверяются', () => {
  expect(findMissingServerOnly('src/ui/Button.tsx', 'export {}')).toBe(false);
});
