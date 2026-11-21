import { expect, test, vi } from 'vitest';
import { applyLogLevel } from '@/lib/log-level';

// LOG_LEVEL действует: сообщения ниже уровня не печатаются (проверка main, Q11).

const fakeConsole = () => ({ debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function printed(level: 'debug' | 'info' | 'warn' | 'error'): string[] {
  const c = fakeConsole();
  const original = { ...c };
  applyLogLevel(level, c);
  for (const name of ['debug', 'info', 'log', 'warn', 'error'] as const) c[name](name);
  return (['debug', 'info', 'log', 'warn', 'error'] as const).filter((name) => original[name].mock.calls.length > 0);
}

test('каждый уровень печатает своё и всё, что важнее', () => {
  expect(printed('debug')).toEqual(['debug', 'info', 'log', 'warn', 'error']);
  expect(printed('info')).toEqual(['info', 'log', 'warn', 'error']);
  expect(printed('warn')).toEqual(['warn', 'error']);
  expect(printed('error')).toEqual(['error']);
});
