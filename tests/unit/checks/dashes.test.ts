import { expect, test } from 'vitest';
import { findDashes, isDashCheckedFile } from '../../../scripts/checks/dashes.mjs';

test('длинное и среднее тире находятся с позицией', () => {
  expect(findDashes('a \u2014 b\nc \u2013 d')).toEqual([
    { line: 1, column: 3, char: 'U+2014' },
    { line: 2, column: 3, char: 'U+2013' },
  ]);
});

test('дефис и минус не считаются нарушением', () => {
  expect(findDashes('a - b, 5 \u2212 3')).toEqual([]);
});

test('несколько тире в одной строке находятся все', () => {
  expect(findDashes('\u2014\u2013').map((v) => v.column)).toEqual([1, 2]);
});

test('файл блокировок и файл правил генератора Next.js не проверяются', () => {
  expect(isDashCheckedFile('pnpm-lock.yaml')).toBe(false);
  expect(isDashCheckedFile('AGENTS.md')).toBe(false);
  expect(isDashCheckedFile('docs/TZ.md')).toBe(true);
  expect(isDashCheckedFile('src/app/page.tsx')).toBe(true);
});
