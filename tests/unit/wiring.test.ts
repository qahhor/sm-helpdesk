import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Связи между модулями через интерфейсы общего модуля собирает src/wiring.ts (аудит 23.11.2026, находка A1).
// Точка входа, которая его не импортирует, получила бы ошибку "справочник контактов не подключён" при первом
// уведомлении. Тест держит перечень точек входа.

const ENTRY_POINTS = ['src/instrumentation-node.ts', 'src/worker/main.ts', 'src/cli/main.ts', 'tests/integration/setup/each.ts'];

test.each(ENTRY_POINTS)('точка входа %s подключает связи модулей первой строкой импорта', (file) => {
  const imports = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('import '));
  expect(imports[0]).toMatch(/^import '(@\/wiring|\.\/wiring)';$/);
});

test('справочник контактов без подключения называет причину, а не молчит', async () => {
  const shared = globalThis as typeof globalThis & { __hubContacts?: unknown };
  const before = shared.__hubContacts;
  delete shared.__hubContacts;
  try {
    const { contacts } = await import('@/modules/hdc/contacts');
    expect(() => contacts()).toThrow('src/wiring.ts');
  } finally {
    shared.__hubContacts = before;
  }
});

test('сервер Next.js подключает связи до первого запроса: файл запуска импортирует instrumentation-node', () => {
  expect(readFileSync('src/instrumentation.ts', 'utf8')).toContain("import('./instrumentation-node')");
});
