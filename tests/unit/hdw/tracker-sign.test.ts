import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { mapTrackerStatus } from '@/modules/hdw/dev-tracker/status-map';
import { trackerSignature, verifyTrackerSignature } from '@/modules/hdw/tracker-sign';
import { signTrackerWebhook } from '../../../scripts/mock-tracker.mjs';

// Вебхук таск-менеджера Smartup (FR-DEV-04; план M8, задача 8): подпись HMAC-SHA256 от "время.тело", окно пять
// минут, статусы таск-менеджера переводятся в четыре статуса портала. Договор предполагаемый
// (docs/integrations/dev-tracker.md).

const SECRET = 'unit-tracker-webhook-secret-0123456789abcdef';
const BODY = '{"event":"task.status_changed","ref":"DEV-1204","status":"done"}';
const NOW = new Date('2026-11-24T10:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);

test('подпись: sha256= и HMAC-SHA256 от "время.тело"; ложный таск-менеджер подписывает так же', () => {
  const signature = trackerSignature(SECRET, T, BODY);
  expect(signature).toBe(`sha256=${createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex')}`);
  expect(signTrackerWebhook(SECRET, T, BODY)).toBe(signature);
});

test('верная подпись в окне пяти минут принимается', () => {
  const check = (timestamp: number, now = NOW) => verifyTrackerSignature({ secret: SECRET, timestamp: String(timestamp), signature: trackerSignature(SECRET, timestamp, BODY), rawBody: BODY, now });
  expect(check(T)).toBe('ok');
  expect(check(T - 300)).toBe('ok');
  expect(check(T + 300)).toBe('ok');
  // Устаревший и "будущий" запрос: подпись верна, время вне окна.
  expect(check(T - 301)).toBe('stale');
  expect(check(T + 301)).toBe('stale');
});

test('чужой секрет, изменённое тело, другое время и чужая запись подписи отклоняются', () => {
  const good = trackerSignature(SECRET, T, BODY);
  const verify = (patch: Partial<Parameters<typeof verifyTrackerSignature>[0]>) => verifyTrackerSignature({ secret: SECRET, timestamp: String(T), signature: good, rawBody: BODY, now: NOW, ...patch });
  expect(verify({})).toBe('ok');
  expect(verify({ secret: 'другой секрет' })).toBe('bad_signature');
  expect(verify({ rawBody: BODY.replace('done', 'todo') })).toBe('bad_signature');
  // Время входит в подпись: перехваченный запрос с новым временем не проходит.
  expect(verify({ timestamp: String(T + 10) })).toBe('bad_signature');
  expect(verify({ signature: trackerSignature('другой секрет', T, BODY) })).toBe('bad_signature');
  expect(verify({ signature: null })).toBe('missing');
  expect(verify({ timestamp: null })).toBe('missing');
  expect(verify({ signature: '' })).toBe('missing');
  for (const signature of [good.slice(7), good.toUpperCase(), `${good}00`, good.slice(0, -2), 'sha256=', 'sha1=abc', `sha256=${'z'.repeat(64)}`]) expect(verify({ signature }), signature).toBe('malformed');
  for (const timestamp of ['-1', '1e9', ' 1795000000', '1795000000.5', 'now', '1'.repeat(13)]) expect(verify({ timestamp }), timestamp).toBe('malformed');
});

test('статусы таск-менеджера: четыре статуса портала, незнакомый статус не переводится', () => {
  for (const [raw, status] of [
    ['todo', 'todo'],
    ['open', 'todo'],
    ['new', 'todo'],
    ['backlog', 'todo'],
    ['in_progress', 'in_progress'],
    ['In Progress', 'in_progress'],
    ['in-progress', 'in_progress'],
    ['doing', 'in_progress'],
    ['review', 'in_progress'],
    ['testing', 'in_progress'],
    ['done', 'done'],
    [' DONE ', 'done'],
    ['closed', 'done'],
    ['released', 'done'],
    ['resolved', 'done'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['rejected', 'cancelled'],
    ['wont_fix', 'cancelled'],
    ['Wont Fix', 'cancelled'],
  ] as const)
    expect(mapTrackerStatus(raw), raw).toBe(status);
  for (const raw of ['blocked', 'on_hold', '', 'constructor', '__proto__', 'toString', null, undefined, 5, {}]) expect(mapTrackerStatus(raw), String(raw)).toBeNull();
});
