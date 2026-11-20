import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { checkContrast, contrastRatio } from '../../../scripts/checks/contrast.mjs';

const pairs = JSON.parse(readFileSync('scripts/checks/contrast-pairs.json', 'utf8'));
const tokens = readFileSync('src/ui/tokens.css', 'utf8');

test('расчёт по WCAG', () => {
  expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  expect(contrastRatio('#FFFFFF', '#027CAA')).toBeCloseTo(4.7, 1);
  expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 1);
});

test('исходная зелёная метка Smartup Web не проходит, исправленная проходит', () => {
  expect(contrastRatio('#1A8F57', '#E8F7EF')).toBeLessThan(4.5);
  expect(contrastRatio('#157A4A', '#E8F7EF')).toBeGreaterThanOrEqual(4.5);
});

test('полупрозрачный фон накладывается на подложку', () => {
  expect(contrastRatio('#79CBE9', 'rgba(1, 146, 201, .22)', '#14191A')).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio('#FFFFFF', 'transparent', '#000000')).toBeCloseTo(21, 1);
});

test('все пары портала проходят 4,5:1 в обеих темах', () => {
  expect(checkContrast(tokens, pairs)).toEqual([]);
});

test('список пар покрывает текст, ссылки, кнопку, шапку, шесть меток и состояния', () => {
  const names = pairs.map((p: { fg: string }) => p.fg);
  for (const fg of [
    'foreground',
    'secondary-foreground',
    'muted-foreground',
    'link',
    'primary-foreground',
    'header-foreground',
    'destructive-on-bg',
    'success',
    'warning',
    'selected-foreground',
    ...['gray', 'green', 'orange', 'purple', 'blue', 'teal'].map((tone) => `label-${tone}-fg`),
  ])
    expect(names, fg).toContain(fg);
});

test('проверка находит плохую пару и называет тему', () => {
  const broken = tokens.replace('--hub-muted-fg: #667072', '--hub-muted-fg: #9AA4A6');
  const found = checkContrast(broken, pairs);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every((f: { theme: string; ratio: number }) => f.theme === 'light' && f.ratio < 4.5)).toBe(true);
});

test('неизвестное имя токена в списке пар считается ошибкой', () => {
  expect(() => checkContrast(tokens, [{ name: 'x', fg: 'no-such-token', bg: 'background' }])).toThrow(/no-such-token/);
});

test('кнопка под указателем остаётся в списке пар (ревью I6)', () => {
  expect(pairs.some((p: { fg: string; bg: string }) => p.fg === 'primary-foreground' && p.bg === 'primary-hover')).toBe(true);
  expect(contrastRatio('#FFFFFF', '#036486')).toBeGreaterThanOrEqual(4.5);
});

test('плохая пара в тёмной теме находится', () => {
  const broken = tokens.replace('--hub-label-gray-fg: #B4BCBF', '--hub-label-gray-fg: #2A3336');
  expect(checkContrast(broken, pairs).map((f: { theme: string }) => f.theme)).toContain('dark');
});

test('файл токенов без блока тёмной темы считается ошибкой, а не светлой темой', () => {
  expect(() => checkContrast(tokens.replaceAll(/^\.dark \{/gm, 'html.dark {'), pairs)).toThrow(/тёмн/);
});
