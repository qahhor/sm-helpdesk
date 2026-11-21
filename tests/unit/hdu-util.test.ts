import { expect, test } from 'vitest';
import type { ClientRole } from '@/modules/hdu/pref';
import { describeUserAgent, mapClientRole, policyNoticeUrl, safeReturnPath } from '@/modules/hdu/util';

test('адрес возврата: только путь внутри портала', () => {
  const fallback = '/ru/agent';
  for (const good of ['/ru/agent', '/ru/tickets/1042?tab=files', '/uz/org', '/ru', '/ru/agent/organizations/019a1111-1111-7111-8111-111111111111'])
    expect(safeReturnPath(good, fallback)).toBe(good);
  // Якорь до сервера не доходит и в адрес возврата не переносится.
  expect(safeReturnPath('/ru/tickets#reply', fallback)).toBe('/ru/tickets');
  const nul = String.fromCharCode(0);
  const bell = String.fromCharCode(7);
  for (const bad of [
    'https://evil.example',
    'http://localhost:3000/ru',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/ru/\\evil',
    '\\\\evil.example',
    'javascript:alert(1)',
    'data:text/html,x',
    'ru/agent',
    '/ru/agent\n/x',
    '/ru/agent\r',
    '/ru/agent\t',
    `/ru/agent${nul}`,
    `/ru${bell}/agent`,
    ' /ru/agent',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/ru/%0d%0aSet-Cookie:x=1',
    '/..//evil.example',
    '',
    null,
    undefined,
    42,
    ['/ru'],
    { path: '/ru' },
    `/${'a'.repeat(2100)}`,
  ])
    expect(safeReturnPath(bad, fallback), String(bad)).toBe(fallback);
});

test('устройство определяется по строке браузера, неизвестное не ломает список', () => {
  expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toEqual({
    browser: 'chrome',
    os: 'windows',
  });
  expect(
    describeUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    ),
  ).toEqual({ browser: 'safari', os: 'ios' });
  expect(describeUserAgent('Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')).toEqual({
    browser: 'chrome',
    os: 'android',
  });
  expect(
    describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'),
  ).toEqual({ browser: 'edge', os: 'windows' });
  expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:140.0) Gecko/20100101 Firefox/140.0')).toEqual({
    browser: 'firefox',
    os: 'macos',
  });
  expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36')).toEqual({
    browser: 'chrome',
    os: 'linux',
  });
  for (const odd of [null, '', 'curl/8.0', '<script>alert(1)</script>', 'x'.repeat(5000), `Chrome/1 Windows NT ${'x'.repeat(5000)}`])
    expect(describeUserAgent(odd)).toEqual({ browser: 'other', os: 'other' });
});

test('роль из Smartup ищется только среди своих ключей соответствия (итоговая проверка M1, мелкое 3)', () => {
  const map = { director: 'client_admin' } as Record<string, ClientRole>;
  expect(mapClientRole(map, 'director')).toBe('client_admin');
  expect(mapClientRole(map, 'manager')).toBe('client_user');
  expect(mapClientRole(map, undefined)).toBe('client_user');
  for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(mapClientRole(map, inherited)).toBe('client_user');
  // Значение вне списка ролей клиента не принимается.
  expect(mapClientRole({ boss: 'admin' } as unknown as Record<string, ClientRole>, 'boss')).toBe('client_user');
});

test('шаг о новой редакции политики возвращает туда, куда шёл человек (итоговая проверка M1, мелкое 6)', () => {
  expect(policyNoticeUrl('ru', '/ru/tickets?status=open')).toBe('/ru/welcome?next=%2Fru%2Ftickets%3Fstatus%3Dopen');
  expect(policyNoticeUrl('uz', 'https://evil.example')).toBe('/uz/welcome?next=%2Fuz');
  expect(policyNoticeUrl('en', '')).toBe('/en/welcome?next=%2Fen');
});
