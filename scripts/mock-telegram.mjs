// Ложный Telegram Bot API для разработки и браузерных тестов (задача 16, решение 0018). Только локально.
//
// Принимает POST /bot<токен>/<метод> для методов getMe, sendMessage, setWebhook, answerCallbackQuery,
// запоминает отправленные сообщения и отдаёт их по адресу GET /__sent (DELETE /__sent очищает список).
// Портал направляют сюда переменной TELEGRAM_API_URL=http://localhost:3192 (только на localhost).
//
// Запуск: pnpm dev:telegram
import { createServer } from 'node:http';

export const MOCK_TELEGRAM_PORT = Number(process.env.MOCK_TELEGRAM_PORT ?? 3192);
export const MOCK_BOT_USERNAME = 'smartup_hub_dev_bot';

/** @typedef {{ chat_id: string; text: string; reply_markup?: unknown }} SentMessage */

/** @returns {import('node:http').Server} */
export function startMockTelegram(port = MOCK_TELEGRAM_PORT) {
  /** @type {SentMessage[]} */
  const sent = [];
  let messageId = 0;
  const json = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__sent') {
      if (req.method === 'DELETE') sent.length = 0;
      return json(res, 200, sent);
    }
    const match = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) return json(res, 404, { ok: false, description: 'Not Found' });
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      /** @type {Record<string, unknown>} */
      let data = {};
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        return json(res, 400, { ok: false, description: 'Bad Request' });
      }
      switch (match[1]) {
        case 'getMe':
          return json(res, 200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Smartup Hub', username: MOCK_BOT_USERNAME } });
        case 'sendMessage':
          sent.push({ chat_id: String(data.chat_id), text: String(data.text), reply_markup: data.reply_markup });
          return json(res, 200, { ok: true, result: { message_id: ++messageId } });
        case 'setWebhook':
        case 'answerCallbackQuery':
          return json(res, 200, { ok: true, result: true });
        default:
          return json(res, 404, { ok: false, description: 'Not Found: method not found' });
      }
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (import.meta.main) {
  startMockTelegram();
  console.log(`Ложный Telegram: http://localhost:${MOCK_TELEGRAM_PORT} (отправленное: /__sent)`);
}
