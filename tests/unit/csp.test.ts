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

test('политика действует, а не только пишет отчёты (аудит 23.11.2026, находка S2)', async () => {
  const { CSP_HEADER } = await import('@/security/csp');
  expect(CSP_HEADER).toBe('Content-Security-Policy');
});

// --- Страницы виджета (план M6, задача 3) ---

test('frame-ancestors с http допускается только для localhost и 127.0.0.1 и только у локального портала', () => {
  const local = buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['http://127.0.0.1:3192', 'https://a.example'], allowLoopbackAncestors: true });
  expect(local).toContain('frame-ancestors http://127.0.0.1:3192 https://a.example');
  expect(() => buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['http://127.0.0.1:3192'] })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['http://evil.example'], allowLoopbackAncestors: true })).toThrow();
  expect(() => buildCsp({ nonce: 'abc', dev: false, frameAncestors: ['http://127.0.0.1:3192/path'], allowLoopbackAncestors: true })).toThrow();
});

test('статический запрет встраивания не ставится только на страницы виджета /{язык}/embed', async () => {
  const { staticHeaderRules } = await import('@/security/csp');
  const { getPathMatch } = await import('next/dist/shared/lib/router/utils/path-match');
  const rules = staticHeaderRules(['ru', 'uz', 'en']).map((rule) => ({ ...rule, match: getPathMatch(rule.source, { strict: true, removeUnnamedParams: true }) }));
  const cspOf = (path: string) =>
    rules
      .filter((rule) => rule.match(path) !== false)
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key === 'Content-Security-Policy')
      .map((header) => header.value);
  for (const path of ['/ru/embed', '/ru/embed/report', '/uz/embed/tickets/SUP-12', '/embed/report']) {
    expect(cspOf(path), path).toEqual(["base-uri 'none'; object-src 'none'"]);
  }
  for (const path of ['/', '/ru', '/ru/tickets', '/ru/m/report', '/api/embed/session', '/api/health', '/ru/embedded', '/ru/agent/embed', '/brand/tez/tez-icon.svg', '/de/embed/report']) {
    expect(cspOf(path), path).toEqual(["frame-ancestors 'none'; base-uri 'none'; object-src 'none'"]);
  }
  // Адрес с расширением файла прокси не обрабатывает (src/proxy.ts, matcher): frame-ancestors ему никто не поставит,
  // поэтому статический запрет остаётся (проверка M6, M4).
  for (const path of ['/ru/embed/report.js', '/ru/embed/x.png', '/embed/a.css', '/uz/embed/tickets/logo.svg', '/ru/embed.json', '/ru/m/report.js', '/en/m/icon.png']) {
    expect(cspOf(path), path).toEqual(["frame-ancestors 'none'; base-uri 'none'; object-src 'none'"]);
  }
  // Остальные заголовки на всех адресах.
  for (const path of ['/ru/embed/report', '/api/health'])
    expect(rules.filter((rule) => rule.match(path) !== false).flatMap((rule) => rule.headers.map((h) => h.key))).toEqual(
      expect.arrayContaining(['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']),
    );
});

test('страницы виджета и мобильного приложения без Referer, загрузчик виджета в кеше 5 минут (план M6, задачи 4 и 7)', async () => {
  const { staticHeaderRules } = await import('@/security/csp');
  const { getPathMatch } = await import('next/dist/shared/lib/router/utils/path-match');
  const rules = staticHeaderRules(['ru', 'uz', 'en']).map((rule) => ({ ...rule, match: getPathMatch(rule.source, { strict: true, removeUnnamedParams: true }) }));
  // Next.js применяет правила по порядку: значение того же заголовка из правила ниже заменяет верхнее.
  const last = (path: string, key: string) =>
    rules
      .filter((rule) => rule.match(path) !== false)
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key === key)
      .at(-1)?.value;
  for (const path of ['/ru/m/report', '/uz/m/report', '/ru/embed/report', '/en/embed/tickets/12'])
    expect(last(path, 'Referrer-Policy'), path).toBe('no-referrer');
  for (const path of ['/ru', '/ru/tickets/new', '/api/embed/session', '/ru/mobile'])
    expect(last(path, 'Referrer-Policy'), path).toBe('strict-origin-when-cross-origin');
  expect(last('/widget/v1/hub-widget.js', 'Cache-Control')).toBe('public, max-age=300');
  expect(last('/ru/tickets', 'Cache-Control')).toBeUndefined();
});
