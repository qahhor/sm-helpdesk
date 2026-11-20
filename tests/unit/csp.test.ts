import { expect, test } from 'vitest';
import { buildCsp, createNonce } from '@/security/csp';

test('политика из раздела 14.4 ТЗ', () => {
  const csp = buildCsp({ nonce: 'abc', dev: false });
  for (const part of [
    "default-src 'self'",
    "script-src 'self' 'nonce-abc' https://challenges.cloudflare.com",
    "style-src 'self' 'nonce-abc'",
    "img-src 'self' data:",
    "connect-src 'self'",
    'frame-src https://challenges.cloudflare.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ])
    expect(csp).toContain(part);
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
});

test('в разработке разрешён eval, которого требует React', () => {
  expect(buildCsp({ nonce: 'abc', dev: true })).toContain("script-src 'self' 'nonce-abc' 'unsafe-eval'");
});

test('хранилище файлов добавляется в img-src и connect-src', () => {
  const csp = buildCsp({ nonce: 'abc', dev: false, storageOrigin: 'https://files.example.test' });
  expect(csp).toContain("img-src 'self' data: https://files.example.test");
  expect(csp).toContain("connect-src 'self' https://files.example.test");
});

test('страницы виджета: список адресов вместо запрета', () => {
  const csp = buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['https://smartup.example.test'] });
  expect(csp).toContain('frame-ancestors https://smartup.example.test');
  expect(csp).not.toContain("frame-ancestors 'none'");
});

test('значения с пробелом, кавычкой или точкой с запятой отклоняются', () => {
  expect(() => buildCsp({ nonce: 'a b', dev: false })).toThrow();
  expect(() => buildCsp({ nonce: "a'b", dev: false })).toThrow();
  expect(() => buildCsp({ nonce: '', dev: false })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['https://x.test; script-src *'] })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, storageOrigin: 'https://x.test/path' })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, storageOrigin: 'http://x.test' })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['*'] })).toThrow();
});

test('одноразовый код: 16 случайных байт, каждый раз новый', () => {
  const a = createNonce();
  const b = createNonce();
  expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(a).not.toBe(b);
  expect(() => buildCsp({ nonce: a, dev: false })).not.toThrow();
});
