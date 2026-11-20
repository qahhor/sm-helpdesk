import { expect, test } from 'vitest';
import { localizedHref, stripLocale } from '@/i18n/paths';

test('адрес с языком', () => {
  expect(localizedHref('ru', '/')).toBe('/ru');
  expect(localizedHref('uz', '/tickets')).toBe('/uz/tickets');
  expect(localizedHref('en', '/agent/dev/ui')).toBe('/en/agent/dev/ui');
});

test('адрес без языка', () => {
  expect(stripLocale('ru', '/ru')).toBe('/');
  expect(stripLocale('uz', '/uz/tickets')).toBe('/tickets');
  expect(stripLocale('en', '/en/tickets/42')).toBe('/tickets/42');
});

test('похожее начало адреса не принимается за язык', () => {
  expect(stripLocale('ru', '/rules')).toBe('/rules');
  expect(stripLocale('ru', '/uz/tickets')).toBe('/uz/tickets');
});
