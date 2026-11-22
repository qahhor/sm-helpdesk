import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { verifySvix } from '@/modules/hdn/svix';

// Подпись вебхука Resend по схеме Svix (решение 10 вехи M4): HMAC-SHA256 над "id.timestamp.body" ключом из base64
// после префикса whsec_, в заголовке несколько подписей "v1,<base64>" через пробел, метка времени в пределах 5 минут.

const key = Buffer.alloc(24, 9).toString('base64');
const secret = `whsec_${key}`;
const now = new Date('2026-11-22T10:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } });
const sign = (keyB64: string, id: string, stamp: string, payload: string) =>
  `v1,${createHmac('sha256', Buffer.from(keyB64, 'base64')).update(`${id}.${stamp}.${payload}`).digest('base64')}`;

test('подпись Svix: верная, одна из нескольких, старше 5 минут, другое тело, другой секрет', () => {
  const good = sign(key, 'msg_1', ts, body);
  expect(verifySvix(secret, 'msg_1', ts, good, body, now)).toBe(true);
  // Несколько подписей при смене секрета: подходит любая.
  expect(verifySvix(secret, 'msg_1', ts, `v1,AAAA ${good}`, body, now)).toBe(true);
  // Метка времени старше и новее 5 минут.
  const old = String(Math.floor(now.getTime() / 1000) - 301);
  expect(verifySvix(secret, 'msg_1', old, sign(key, 'msg_1', old, body), body, now)).toBe(false);
  const future = String(Math.floor(now.getTime() / 1000) + 301);
  expect(verifySvix(secret, 'msg_1', future, sign(key, 'msg_1', future, body), body, now)).toBe(false);
  // Другое тело, другой идентификатор, другой секрет.
  expect(verifySvix(secret, 'msg_1', ts, good, `${body} `, now)).toBe(false);
  expect(verifySvix(secret, 'msg_2', ts, good, body, now)).toBe(false);
  expect(verifySvix(`whsec_${Buffer.alloc(24, 8).toString('base64')}`, 'msg_1', ts, good, body, now)).toBe(false);
});

test('пустые и испорченные заголовки подписи не проходят и не бросают', () => {
  expect(verifySvix(secret, '', ts, sign(key, '', ts, body), body, now)).toBe(false);
  expect(verifySvix(secret, 'msg_1', 'не число', sign(key, 'msg_1', ts, body), body, now)).toBe(false);
  expect(verifySvix(secret, 'msg_1', ts, '', body, now)).toBe(false);
  expect(verifySvix(secret, 'msg_1', ts, 'v2,abc v1', body, now)).toBe(false);
  expect(verifySvix('без-префикса', 'msg_1', ts, sign(key, 'msg_1', ts, body), body, now)).toBe(false);
});
