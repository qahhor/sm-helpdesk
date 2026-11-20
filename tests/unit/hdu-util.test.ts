import { expect, test } from 'vitest';
import { safeReturnPath } from '@/modules/hdu/util';

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
