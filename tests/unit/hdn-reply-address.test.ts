import { expect, test } from 'vitest';
import { parseReplyAddress, replyAddress } from '@/modules/hdn/inbound/reply-address';

// Адрес для ответа на письмо (раздел 11.8 ТЗ, FR-NT-06, решение 9 вехи M4): номер обращения, пользователь и подпись
// HMAC. Письмо на адрес с неверной подписью отбрасывается.

const cfg = { domain: 'reply.example.test', secret: 'reply-secret-of-at-least-32-chars!!' };
const userId = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

test('адрес ответа: туда и обратно, верхний регистр, местная часть не длиннее 64', () => {
  const address = replyAddress(1042, userId, cfg);
  expect(address).toMatch(/^reply\+1042\.[a-z2-7]{26}\.[0-9a-f]{20}@reply\.example\.test$/);
  expect(parseReplyAddress(address, cfg)).toEqual({ number: 1042, userId });
  expect(parseReplyAddress(address.toUpperCase(), cfg)).toEqual({ number: 1042, userId });
  expect(parseReplyAddress(`  ${address} `, cfg)).toEqual({ number: 1042, userId });
  const long = replyAddress(9_999_999, 'ffffffff-ffff-7fff-bfff-ffffffffffff', cfg);
  expect(long.split('@')[0]!.length).toBeLessThanOrEqual(64);
  expect(parseReplyAddress(long, cfg)).toEqual({ number: 9_999_999, userId: 'ffffffff-ffff-7fff-bfff-ffffffffffff' });
});

test('одна изменённая буква подписи, чужой домен, лишняя точка: null', () => {
  const address = replyAddress(1042, userId, cfg);
  const [local, domain] = address.split('@') as [string, string];
  const flipped = `${local.slice(0, -1)}${local.endsWith('0') ? '1' : '0'}@${domain}`;
  expect(parseReplyAddress(flipped, cfg)).toBeNull();
  expect(parseReplyAddress(`${local}@evil.example`, cfg)).toBeNull();
  expect(parseReplyAddress(`${local}.@${domain}`, cfg)).toBeNull();
  expect(parseReplyAddress(address.replace('reply+1042', 'reply+1043'), cfg)).toBeNull();
  expect(parseReplyAddress('support@reply.example.test', cfg)).toBeNull();
  expect(parseReplyAddress('', cfg)).toBeNull();
  // Другой секрет: адрес чужой.
  expect(parseReplyAddress(address, { ...cfg, secret: 'another-secret-of-at-least-32-chars' })).toBeNull();
});
