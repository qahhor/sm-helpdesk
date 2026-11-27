import { expect, test } from 'vitest';
import { aiCallbackData, aiLinkToken, AI_LINK_TTL_MS, parseAiCallbackData, parseAiLinkToken } from '@/modules/hdt/ai-link';

// Ссылка из письма и кнопка Telegram под ответом Теза (план M5b, задача 6; FR-NT-11, FR-EM-12; пункт 7 проверки на
// AI-инъекции). Подпись связывает получателя, сообщение и выбор; ссылка действует 7 суток; данные кнопки Telegram не
// длиннее 64 байт. Таблицы нет: одноразовость держит само обращение (второе нажатие видит, что ответ уже учтён).

const SECRET = 'reply-secret-of-at-least-32-chars!!';
const OLD = 'previous-secret-of-at-least-32-chars';
const MESSAGE = '01900000-0000-7000-8000-00000000c001';
const USER = '01900000-0000-7000-8000-00000000d001';
const NOW = new Date('2026-11-26T10:00:00Z');

test('ссылка: получатель, сообщение, выбор и срок под подписью; старый ключ принимается', () => {
  const token = aiLinkToken({ messageId: MESSAGE, userId: USER, choice: 'helped', now: NOW }, SECRET);
  expect(token).toMatch(/^[0-9a-z.]+$/);
  expect(parseAiLinkToken(token, [SECRET], NOW)).toEqual({ ok: true, messageId: MESSAGE, userId: USER, choice: 'helped' });
  expect(parseAiLinkToken(token, [OLD, SECRET], NOW)).toMatchObject({ ok: true });
  expect(parseAiLinkToken(aiLinkToken({ messageId: MESSAGE, userId: USER, choice: 'need_staff', now: NOW }, SECRET), [SECRET], NOW)).toMatchObject({ choice: 'need_staff' });
});

test('ссылка: чужая подпись, подмена выбора, получателя или сообщения, порча и истёкший срок отклоняются', () => {
  const token = aiLinkToken({ messageId: MESSAGE, userId: USER, choice: 'helped', now: NOW }, SECRET);
  const parts = token.split('.');
  expect(parseAiLinkToken(token, ['other-secret-0123456789abcdef0123456789'], NOW)).toEqual({ ok: false, code: 'link_invalid' });
  expect(parseAiLinkToken([parts[0], parts[1], parts[2], 's', parts[4]].join('.'), [SECRET], NOW)).toEqual({ ok: false, code: 'link_invalid' });
  expect(parseAiLinkToken([parts[0], 'd'.repeat(32), ...parts.slice(2)].join('.'), [SECRET], NOW)).toEqual({ ok: false, code: 'link_invalid' });
  expect(parseAiLinkToken(['c'.repeat(32), ...parts.slice(1)].join('.'), [SECRET], NOW)).toEqual({ ok: false, code: 'link_invalid' });
  expect(parseAiLinkToken('мусор', [SECRET], NOW)).toEqual({ ok: false, code: 'link_invalid' });
  expect(AI_LINK_TTL_MS).toBe(7 * 86_400_000);
  expect(parseAiLinkToken(token, [SECRET], new Date(NOW.getTime() + AI_LINK_TTL_MS + 1000))).toEqual({ ok: false, code: 'expired' });
});

test('кнопка Telegram: не длиннее 64 байт, привязана к пользователю бота', () => {
  const data = aiCallbackData({ messageId: MESSAGE, userId: USER, choice: 'helped' }, SECRET);
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  expect(data.startsWith('tz:')).toBe(true);
  expect(parseAiCallbackData(data, USER, [SECRET])).toEqual({ messageId: MESSAGE, choice: 'helped' });
  // Чужой пользователь бота с той же кнопкой (пересланное сообщение) не проходит.
  expect(parseAiCallbackData(data, '01900000-0000-7000-8000-00000000d002', [SECRET])).toBeNull();
  expect(parseAiCallbackData(data.replace('tz:h', 'tz:s'), USER, [SECRET])).toBeNull();
  expect(parseAiCallbackData('lang:ru', USER, [SECRET])).toBeNull();
});
