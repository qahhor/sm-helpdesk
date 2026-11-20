import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseLayer1, parseScssVars } from './helpers/tokens';

const css = readFileSync('src/ui/tokens.css', 'utf8');

test('слой 1 совпадает с поставкой Smartup Web', () => {
  const delivered = parseScssVars(readFileSync('docs/design/smartup-tokens.scss', 'utf8'));
  const layer1 = parseLayer1(css);
  expect(delivered.light.bg).toBe('#F3F6F7');
  expect(delivered.dark.card).toBe('#14191A');
  expect(layer1.light).toEqual(delivered.light);
  expect(layer1.dark).toEqual(delivered.dark);
});

test('размеры из раздела 8.11 ТЗ', () => {
  for (const line of [
    '--spacing-header: 52px',
    '--spacing-row: 48px',
    '--spacing-control: 40px',
    '--spacing-field: 46px',
    '--radius-card: 14px',
    '--radius-control: 10px',
  ])
    expect(css).toContain(line);
  expect(css).toMatch(/\[data-zone="client"\]\s*\{[^}]*--spacing-control:\s*44px[^}]*--text-base:\s*16px/);
});

test('точки перелома совпадают с поставкой Smartup Web', () => {
  const scss = readFileSync('docs/design/smartup-breakpoints.scss', 'utf8');
  const delivered = (name: string) => new RegExp(`\\$bp-${name}:\\s*(\\d+px)`).exec(scss)?.[1];
  for (const [ours, theirs] of [
    ['tablet', 'tablet'],
    ['laptop', 'laptop'],
    ['burger', 'burger'],
    ['desktop', 'desktop'],
    ['wide', 'full-nav'],
  ])
    expect(css).toContain(`--breakpoint-${ours}: ${delivered(theirs)}`);
});

test('слой 2 не содержит своих цветов: только ссылки на слой 1 и поправки портала', () => {
  const theme = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  expect(theme).toContain('--color-background: var(--sm-bg)');
  expect(theme).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/);
});

test('шрифт семейства Montserrat с запасными системными', () => {
  expect(css).toMatch(/--font-sans:\s*"Montserrat", system-ui, sans-serif/);
});
