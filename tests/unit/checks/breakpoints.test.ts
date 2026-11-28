import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { definedBreakpoints, findDeadBreakpoints } from '../../../scripts/checks/breakpoints.mjs';

// Точки перелома Tailwind по умолчанию сброшены в src/ui/tokens.css: класс с префиксом sm:, md:, lg:, xl:, 2xl:
// молча не даёт CSS (проверка интерфейса, U1). Правило читает файл токенов и падает на такие префиксы.

const TOKENS = `@theme {
  --breakpoint-*: initial;
  --breakpoint-tablet: 600px;
  --breakpoint-laptop: 1024px;
}`;

test('читает точки перелома из файла токенов', () => {
  expect(definedBreakpoints(TOKENS)).toEqual({ reset: true, names: ['tablet', 'laptop'] });
  expect(definedBreakpoints('@theme { --breakpoint-tablet: 600px; }')).toEqual({ reset: false, names: ['tablet'] });
});

test.each([
  ['<div className="grid lg:grid-cols-3" />', 'lg'],
  ['<div className="sm:flex-row" />', 'sm'],
  ['<div className="grid gap-2 md:grid-cols-3" />', 'md'],
  ['const c = cn("xl:w-60", x);', 'xl'],
  ['<div className="2xl:hidden" />', '2xl'],
  ['<div className="max-lg:hidden" />', 'lg'],
  ['<div className="dark:lg:flex" />', 'lg'],
])('находит мёртвый префикс в %s', (text, prefix) => {
  expect(findDeadBreakpoints(text, definedBreakpoints(TOKENS))).toEqual([{ line: 1, rule: `dead-breakpoint ${prefix}:` }]);
});

test('точки перелома проекта и похожие записи проходят', () => {
  const text = [
    '<div className="tablet:grid-cols-2 laptop:flex-row max-tablet:hidden" />',
    "const size = { sm: 'h-control-small', md: 'h-control', lg: 'h-field' };",
    '<p className="text-sm rounded-lg" />',
  ].join('\n');
  expect(findDeadBreakpoints(text, definedBreakpoints(TOKENS))).toEqual([]);
});

test('без сброса стандартные префиксы работают, правило молчит', () => {
  expect(findDeadBreakpoints('<div className="lg:flex" />', definedBreakpoints('@theme { --breakpoint-tablet: 600px; }'))).toEqual([]);
});

test('точка перелома, заданная в токенах заново, не считается мёртвой', () => {
  const tokens = '@theme { --breakpoint-*: initial; --breakpoint-lg: 1024px; }';
  expect(findDeadBreakpoints('<div className="lg:flex sm:flex" />', definedBreakpoints(tokens))).toEqual([{ line: 1, rule: 'dead-breakpoint sm:' }]);
});

test('файл токенов проекта сбрасывает стандартные точки', () => {
  const defined = definedBreakpoints(readFileSync('src/ui/tokens.css', 'utf8'));
  expect(defined.reset).toBe(true);
  expect(defined.names).toEqual(['tablet', 'laptop', 'burger', 'desktop', 'wide']);
});
