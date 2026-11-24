import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { signatureHeader } from '@/modules/hdw/webhook-sign';

// Подпись исходящего вебхука (план M8, решение 9): t=<секунды>,v1=<HMAC-SHA256 от "<секунды>.<тело>">.

test('подпись: время и HMAC-SHA256 от "время.тело" секретом адреса', () => {
  const body = '{"event":"test"}';
  const header = signatureHeader('секрет', 1_795_000_000, body);
  expect(header).toBe(`t=1795000000,v1=${createHmac('sha256', 'секрет').update(`1795000000.${body}`).digest('hex')}`);
  expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  // Другое тело, время или секрет дают другую подпись.
  expect(signatureHeader('секрет', 1_795_000_000, `${body} `)).not.toBe(header);
  expect(signatureHeader('секрет', 1_795_000_001, body).split(',')[1]).not.toBe(header.split(',')[1]);
  expect(signatureHeader('другой', 1_795_000_000, body)).not.toBe(header);
});
