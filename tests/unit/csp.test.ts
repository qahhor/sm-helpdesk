import { expect, test } from 'vitest';
import { buildCsp, createNonce, storageOriginOf } from '@/security/csp';

test('политика из раздела 14.4 ТЗ', () => {
  const csp = buildCsp({ nonce: 'abc', dev: false });
  for (const part of [
    "default-src 'self'",
    "script-src 'self' 'nonce-abc' https://challenges.cloudflare.com",
    "style-src 'self' 'nonce-abc'",
    "img-src 'self' data: blob:",
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
  // Нарушения в режиме отчётов приходят порталу (проверка main, S9).
  expect(csp).toContain('report-uri /api/csp-report');
});

test('в разработке разрешён eval, которого требует React', () => {
  expect(buildCsp({ nonce: 'abc', dev: true })).toContain("script-src 'self' 'nonce-abc' 'unsafe-eval'");
});

test('хранилище файлов добавляется в img-src и connect-src', () => {
  const csp = buildCsp({ nonce: 'abc', dev: false, storageOrigin: 'https://files.example.test' });
  expect(csp).toContain("img-src 'self' data: blob: https://files.example.test");
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

test('запрет встраивания действует уже сейчас, а не только в отчётах (ревью M9)', async () => {
  const { STATIC_SECURITY_HEADERS } = await import('@/security/csp');
  const enforced = STATIC_SECURITY_HEADERS.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  for (const part of ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"]) expect(enforced).toContain(part);
});

test('адрес хранилища для политики берётся из R2_ENDPOINT только при FILE_STORAGE=r2 (решение 0027)', () => {
  expect(storageOriginOf({ FILE_STORAGE: 'r2', R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' })).toBe('https://acct.r2.cloudflarestorage.com');
  expect(storageOriginOf({ FILE_STORAGE: 'local', R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' })).toBeUndefined();
  expect(storageOriginOf({})).toBeUndefined();
  const csp = buildCsp({ nonce: 'abc', dev: false, storageOrigin: storageOriginOf({ FILE_STORAGE: 'r2', R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' }) });
  expect(csp).toContain('connect-src \'self\' https://acct.r2.cloudflarestorage.com');
  expect(csp).toContain("img-src 'self' data: blob: https://acct.r2.cloudflarestorage.com");
});
