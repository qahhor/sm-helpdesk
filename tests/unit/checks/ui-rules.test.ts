import { expect, test } from 'vitest';
import { findUiRuleViolations } from '../../../scripts/checks/ui-rules.mjs';

test.each([
  ['<p className="text-[#027CAA]" />', 'raw-color'],
  ['const c = "#fff";', 'raw-color'],
  ['const c = "rgb(2 124 170)";', 'raw-color'],
  ['const c = "oklch(0.6 0.1 230)";', 'raw-color'],
  ['<p className="h-[52px]" />', 'arbitrary-size'],
  ['<p className="text-[0.9em]" />', 'arbitrary-size'],
  ['<p className="ml-4 text-left" />', 'physical-direction'],
  ['<p className="md:pr-2" />', 'physical-direction'],
  ['<p className="-ml-1" />', 'physical-direction'],
  ['<p className="rounded-tl-lg" />', 'physical-direction'],
  ['<p className="border-l" />', 'physical-direction'],
  ['<p className="bg-[var(--sm-pri)]" />', 'layer1-token'],
])('находит %s', (text, rule) => {
  expect(findUiRuleViolations('src/ui/x.tsx', text).map((v) => v.rule)).toContain(rule);
});

test('логические классы и токены проходят', () => {
  expect(
    findUiRuleViolations('src/ui/x.tsx', '<p className="ms-4 text-start bg-primary h-control border-s rounded-s-lg" />'),
  ).toEqual([]);
});

test('якорь, код символа и слова со слогом left не считаются нарушением', () => {
  const text = '<a href="/docs#install">x</a>\nconst s = "&#8212;";\nconst cls = "justify-items-left-x border-line";';
  expect(findUiRuleViolations('src/ui/x.tsx', text)).toEqual([]);
});

test('токены слоя 1 разрешены только в файле токенов', () => {
  expect(findUiRuleViolations('src/ui/tokens.css', ':root { --sm-pri: #027CAA; }')).toEqual([]);
  expect(findUiRuleViolations('src/app/globals.css', 'a { color: var(--sm-pri); }').map((v) => v.rule)).toEqual([
    'layer1-token',
  ]);
});

test('цвет в таблице стилей вне файла токенов запрещён', () => {
  expect(findUiRuleViolations('src/app/globals.css', 'a { color: #027CAA; }').map((v) => v.rule)).toEqual([
    'raw-color',
  ]);
});
