import { expect, test, vi } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { BOT_TEXT_KEYS, botText } from '@/modules/hdn/bot-text';
import { createTelegramBot } from '@/modules/hdn/telegram';
import { telegramUpdate } from '@/modules/hdn/telegram-update';

// Клиент Bot API, схема события и тексты бота (задача 16, решение 0018).

type Init = { body: string; method: string };
const okFetch = () => vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true, result: {} })));

test('клиент Bot API отправляет сообщение с кнопкой-ссылкой и не раскрывает токен в ошибке', async () => {
  const fetch = okFetch();
  const bot = createTelegramBot({ token: '123:secret-token', secret: 's'.repeat(32), apiUrl: 'https://api.telegram.org', fetch });
  await bot.sendMessage('777001', 'Привет', { linkButton: { text: 'Открыть портал', url: 'https://hub.smartup24.com/ru' } });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, Init];
  expect(url).toBe('https://api.telegram.org/bot123:secret-token/sendMessage');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toMatchObject({
    chat_id: '777001',
    text: 'Привет',
    reply_markup: { inline_keyboard: [[{ text: 'Открыть портал', url: 'https://hub.smartup24.com/ru' }]] },
  });
  const failing = createTelegramBot({
    token: '123:secret-token',
    secret: 's'.repeat(32),
    apiUrl: 'https://api.telegram.org',
    fetch: vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 })),
  });
  const error = await failing.sendMessage('1', 'x').catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toContain('secret-token');
});

test('кнопки выбора уходят как кнопки с данными, имя бота запрашивается один раз', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true, result: { username: 'hub_bot' } })));
  const bot = createTelegramBot({ token: '1:t', secret: 's'.repeat(32), apiUrl: 'https://api.telegram.org', fetch });
  await bot.sendMessage('1', 'Язык', { choices: [{ text: 'Русский', data: 'lang:ru' }, { text: 'English', data: 'lang:en' }] });
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, Init])[1].body).reply_markup).toEqual({
    inline_keyboard: [[{ text: 'Русский', callback_data: 'lang:ru' }, { text: 'English', callback_data: 'lang:en' }]],
  });
  expect(await bot.getMe()).toEqual({ username: 'hub_bot' });
  expect(await bot.getMe()).toEqual({ username: 'hub_bot' });
  expect(fetch.mock.calls.filter((call) => String(call[0]).endsWith('/getMe'))).toHaveLength(1);
});

test('вебхук ставится с секретом и только нужными видами событий', async () => {
  const fetch = okFetch();
  const bot = createTelegramBot({ token: '1:t', secret: 's'.repeat(32), apiUrl: 'https://api.telegram.org', fetch });
  await bot.setWebhook('https://hub.smartup24.com/api/webhooks/telegram', 's'.repeat(32));
  const [url, init] = fetch.mock.calls[0] as unknown as [string, Init];
  expect(url).toBe('https://api.telegram.org/bot1:t/setWebhook');
  expect(JSON.parse(init.body)).toEqual({
    url: 'https://hub.smartup24.com/api/webhooks/telegram',
    secret_token: 's'.repeat(32),
    allowed_updates: ['message', 'callback_query'],
  });
});

test('секрет вебхука сравнивается целиком', () => {
  const bot = createTelegramBot({ token: '1:t', secret: 'a'.repeat(32), apiUrl: 'https://api.telegram.org', fetch: okFetch() });
  expect(bot.checkSecret('a'.repeat(32))).toBe(true);
  for (const wrong of [null, '', 'a'.repeat(31), `${'a'.repeat(32)}x`, 'b'.repeat(32)]) expect(bot.checkSecret(wrong)).toBe(false);
});

test('без токена бот выключен', () => {
  const bot = createTelegramBot({ apiUrl: 'https://api.telegram.org' });
  expect(bot.enabled).toBe(false);
  expect(bot.checkSecret('a'.repeat(32))).toBe(false);
});

test('сервис не ответил за 5 секунд: ошибка без токена', async () => {
  const bot = createTelegramBot({
    token: '1:secret-token',
    secret: 's'.repeat(32),
    apiUrl: 'https://api.telegram.org',
    fetch: vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {})),
    timeoutMs: 30,
  });
  const error = await bot.sendMessage('1', 'x').catch((e: Error) => e);
  expect(String((error as Error).message)).not.toContain('secret-token');
});

test('событие Telegram разбирается по схеме, лишнее отбрасывается', () => {
  const parsed = telegramUpdate.parse({
    update_id: 10,
    message: {
      message_id: 1,
      from: { id: 777001, is_bot: false, first_name: 'Алишер', language_code: 'uz' },
      chat: { id: 777001, type: 'private' },
      text: '/start abc',
      photo: [{}],
    },
  });
  expect(parsed.message).not.toHaveProperty('photo');
  expect(parsed.message?.from?.language_code).toBe('uz');
  expect(telegramUpdate.safeParse({ update_id: 'x' }).success).toBe(false);
  expect(
    telegramUpdate.safeParse({
      update_id: 1,
      message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'x' }, chat: { id: 1, type: 'private' }, text: 'я'.repeat(4097) },
    }).success,
  ).toBe(false);
  expect(
    telegramUpdate.safeParse({ update_id: 2, callback_query: { id: 'q', from: { id: 1, is_bot: false, first_name: 'x' }, data: 'x'.repeat(65) } }).success,
  ).toBe(false);
});

test('тексты бота есть на трёх языках и не содержат запрещённых слов', () => {
  for (const locale of LOCALES)
    for (const key of BOT_TEXT_KEYS) {
      const text = botText(locale, key, { name: 'Алишер', org: 'ACME', minutes: '10' });
      expect(text.length, `${locale} ${key}`).toBeGreaterThan(3);
      expect(text).not.toMatch(/Smartup ERP|\bdala\b|[{}]/i);
    }
});
