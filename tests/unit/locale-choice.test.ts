import { expect, test } from 'vitest';
import { parseLocaleChoice } from '@/i18n/locale-choice';

test('обычный выбор языка сохраняет страницу', () => {
  expect(parseLocaleChoice('uz', '/tickets/42')).toEqual({ locale: 'uz', path: '/tickets/42' });
});

test('неизвестный язык заменяется языком по умолчанию', () => {
  expect(parseLocaleChoice('xx', '/tickets').locale).toBe('ru');
  expect(parseLocaleChoice(undefined, '/tickets').locale).toBe('ru');
});

test('адрес вне портала, с переводом строки или слишком длинный заменяется главной (ревью M6)', () => {
  const CRLF = String.fromCharCode(13, 10);
  for (const path of ['//evil.example.test', '/..//evil.example.test', `/${CRLF}Set-Cookie: a=b`, 'https://evil.example.test', '/a b', `/${'x'.repeat(3000)}`, 42, null])
    expect(parseLocaleChoice('ru', path).path, String(path).slice(0, 30)).toBe('/');
});
