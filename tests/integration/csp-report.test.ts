import { expect, test, vi } from 'vitest';
import { handleCspReport } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';

// Приём отчётов о нарушениях CSP (проверка main, S9): открытый адрес без входа, поэтому тип, размер
// и частота ограничены, а в журнал попадает только разобранная строка.

const report = (ip: string, body: string, type = 'application/csp-report') =>
  new Request('http://localhost:3000/api/csp-report', { method: 'POST', headers: { 'content-type': type, 'x-forwarded-for': ip }, body });

const legacy = JSON.stringify({
  'csp-report': { 'document-uri': 'http://localhost:3000/ru/invite?token=t', 'violated-directive': 'img-src', 'blocked-uri': 'https://evil.example/a.png' },
});

test('отчёт принимается и пишется в журнал одной строкой без параметров адреса', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const response = await handleCspReport(report('203.0.113.60', legacy));
  expect(response.status).toBe(204);
  expect(warn).toHaveBeenCalledWith('CSP: img-src на /ru/invite, источник https://evil.example');
  warn.mockRestore();
});

test('чужой тип, большое тело и не JSON отклоняются', async () => {
  expect((await handleCspReport(report('203.0.113.61', legacy, 'text/plain'))).status).toBe(415);
  expect((await handleCspReport(report('203.0.113.61', 'x'.repeat(20_000)))).status).toBe(413);
  expect((await handleCspReport(report('203.0.113.61', '{not json'))).status).toBe(400);
  expect((await handleCspReport(new Request('http://localhost:3000/api/csp-report'))).status).toBe(405);
});

test('отчёты с одного адреса ограничены по частоте', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let i = 0; i < RATE_RULES.cspReportPerIp.limit; i++) expect((await handleCspReport(report('203.0.113.62', legacy))).status).toBe(204);
  expect((await handleCspReport(report('203.0.113.62', legacy))).status).toBe(429);
  warn.mockRestore();
});
