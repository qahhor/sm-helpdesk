import { expect } from '@playwright/test';

// Telegram в браузерных тестах: ложный Bot API (scripts/mock-telegram.mjs, порт 3192) и вебхук портала.
// Номера событий и аккаунты Telegram уникальны в каждом прогоне: база разработки хранит принятые события.

export const MOCK_TELEGRAM = 'http://localhost:3192';
export const TELEGRAM_WEBHOOK_SECRET = 'e2e-telegram-webhook-secret-0123456789abcdef';
const PORTAL = 'http://localhost:3100';

let serial = 0;
/** Аккаунт Telegram, которого ещё не было. */
export const uniqueTelegramId = () => Number(`8${String(Date.now()).slice(-8)}${(serial++ % 10).toString()}`);

/** Событие бота в вебхук портала, как его прислал бы Telegram. */
export async function sendTelegramUpdate(opts: { from: number; text?: string; callback?: string }): Promise<void> {
  const update_id = Number(`${String(Date.now()).slice(-9)}${(serial++ % 100).toString().padStart(2, '0')}`);
  const from = { id: opts.from, is_bot: false, first_name: 'Тест', username: `e2e${opts.from}` };
  const chat = { id: opts.from, type: 'private' };
  const body =
    opts.callback !== undefined
      ? { update_id, callback_query: { id: `q${update_id}`, from, data: opts.callback, message: { message_id: 1, chat } } }
      : { update_id, message: { message_id: 1, from, chat, text: opts.text ?? '' } };
  const response = await fetch(`${PORTAL}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] } };

/** Последнее сообщение бота в диалог: текст и кнопка-ссылка, если есть. */
export async function lastBotMessage(chatId: number): Promise<{ text: string; linkButton?: { text: string; url: string } }> {
  const sent = (await (await fetch(`${MOCK_TELEGRAM}/__sent`)).json()) as Sent[];
  const message = sent.filter((m) => m.chat_id === String(chatId)).at(-1);
  if (!message) throw new Error(`Бот не писал в диалог ${chatId}`);
  const button = message.reply_markup?.inline_keyboard?.flat().find((b) => b.url);
  return { text: message.text, linkButton: button?.url ? { text: button.text, url: button.url } : undefined };
}
