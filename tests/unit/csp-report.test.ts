import { expect, test } from 'vitest';
import { describeCspReports } from '@/security/csp-report';

// Отчёт о нарушении CSP превращается в строки журнала без лишнего (проверка main, S9):
// только путь страницы без параметров (в них бывают токены ссылок), директива и источник без пути.

test('отчёт старого вида report-uri', () => {
  const body = {
    'csp-report': {
      'document-uri': 'https://hub.example/ru/invite?token=secret-token',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example/x.js?k=1',
      'script-sample': 'alert(1)',
    },
  };
  expect(describeCspReports(body)).toEqual(['CSP: script-src-elem на /ru/invite, источник https://evil.example']);
});

test('отчёты нового вида Reporting API приходят массивом', () => {
  const body = [
    { type: 'csp-violation', body: { documentURL: 'https://hub.example/ru/tickets#x', effectiveDirective: 'style-src-attr', blockedURL: 'inline' } },
    { type: 'deprecation', body: { id: 'x' } },
  ];
  expect(describeCspReports(body)).toEqual(['CSP: style-src-attr на /ru/tickets, источник inline']);
});

test('посторонние знаки и длинные значения не попадают в журнал', () => {
  const body = { 'csp-report': { 'document-uri': 'https://hub.example/ru/a\nb', 'violated-directive': 'img-src\r\nX: y', 'blocked-uri': 'data' } };
  const [line] = describeCspReports(body);
  expect(line).not.toMatch(/[\r\n]/);
  const long = describeCspReports({ 'csp-report': { 'document-uri': `https://hub.example/${'a'.repeat(500)}`, 'violated-directive': 'img-src', 'blocked-uri': 'data' } });
  expect((long[0] as string).length).toBeLessThan(260);
});

test('не отчёт и слишком много отчётов: пусто или не больше десяти строк', () => {
  expect(describeCspReports({ hello: 'world' })).toEqual([]);
  expect(describeCspReports('text')).toEqual([]);
  const many = Array.from({ length: 50 }, () => ({ type: 'csp-violation', body: { documentURL: 'https://hub.example/ru', effectiveDirective: 'img-src', blockedURL: 'data' } }));
  expect(describeCspReports(many)).toHaveLength(10);
});
