import { expect, test } from 'vitest';
import { BUDGET_BYTES, sumScriptBytes } from '../../../scripts/checks/bundle-budget.mjs';

test('считаются только скрипты, по сжатому размеру', () => {
  expect(
    sumScriptBytes([
      { url: '/_next/a.js', resourceType: 'script', encodedBytes: 100_000 },
      { url: '/_next/b.js', resourceType: 'script', encodedBytes: 60_000 },
      { url: '/_next/c.css', resourceType: 'stylesheet', encodedBytes: 50_000 },
      { url: '/brand/logo.png', resourceType: 'image', encodedBytes: 30_000 },
    ]),
  ).toBe(160_000);
});

test('один и тот же файл считается один раз', () => {
  expect(
    sumScriptBytes([
      { url: '/_next/a.js', resourceType: 'script', encodedBytes: 100_000 },
      { url: '/_next/a.js', resourceType: 'script', encodedBytes: 100_000 },
    ]),
  ).toBe(100_000);
});

test('порог из раздела 8.9 ТЗ', () => {
  expect(BUDGET_BYTES).toBe(170 * 1024);
});
