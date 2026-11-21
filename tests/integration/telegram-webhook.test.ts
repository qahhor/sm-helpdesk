import { expect, test } from 'vitest';
import { createTelegramBot, handleTelegramWebhook } from '@/modules/hdn/api';
import { MemoryTelegramBot, setTelegramBotForTests } from '@/modules/hdn/testing';
import { handleTelegramUpdate } from '@/modules/hdu/api/telegram';
import { pools } from './helpers/db';
import { memoryBotPerTest, tgUpdate } from './helpers/telegram';

// Вебхук бота (задача 16): секрет, размер, схема, повторная доставка.

const tg = memoryBotPerTest();
const SECRET = MemoryTelegramBot.SECRET;

const post = (
  body: unknown,
  headers: Record<string, string> = { 'x-telegram-bot-api-secret-token': SECRET },
  method = 'POST',
  onUpdate: Parameters<typeof handleTelegramWebhook>[1] = handleTelegramUpdate,
) =>
  handleTelegramWebhook(
    new Request('http://localhost:3000/api/webhooks/telegram', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    onUpdate,
  );

test('запрос без секретного заголовка или с чужим отклоняется и не обрабатывается', async () => {
  const wrongHeaders: Record<string, string>[] = [{}, { 'x-telegram-bot-api-secret-token': 'wrong' }, { 'x-telegram-bot-api-secret-token': `${SECRET}x` }];
  for (const headers of wrongHeaders) {
    const response = await post(tgUpdate({ from: 555, text: 'привет' }), headers);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  }
  expect(tg.bot.sent).toEqual([]);
});

test('событие обрабатывается, повторная доставка ничего не делает', async () => {
  const update = tgUpdate({ from: 555, text: 'привет', updateId: 9001 });
  expect((await post(update)).status).toBe(200);
  expect((await post(update)).status).toBe(200);
  expect(tg.bot.sent).toHaveLength(1);
  expect((await pools.root.query(`select update_id from hdn_telegram_updates`)).rows).toEqual([{ update_id: '9001' }]);
});

test('сбой обработки до записи отвечает 500 и позволяет Telegram прислать событие снова', async () => {
  const update = tgUpdate({ from: 555, text: 'привет', updateId: 9002 });
  let calls = 0;
  const flaky = async (incoming: Parameters<typeof handleTelegramUpdate>[0]) => {
    calls += 1;
    if (calls === 1) throw new Error('база недоступна');
    await handleTelegramUpdate(incoming);
  };
  expect((await post(update, undefined, 'POST', flaky)).status).toBe(500);
  expect((await post(update, undefined, 'POST', flaky)).status).toBe(200);
  expect(tg.bot.sent).toHaveLength(1);
});

test('сбой самого ответа бота не превращается в ошибку вебхука: повтор дал бы неверный ответ (итоговая проверка, I4)', async () => {
  const update = tgUpdate({ from: 555, text: 'привет', updateId: 9003 });
  tg.bot.failNext();
  expect((await post(update)).status).toBe(200);
  expect((await pools.root.query(`select update_id from hdn_telegram_updates where update_id = 9003`)).rowCount).toBe(1);
});

test('слишком большое и неверное тело отклоняются', async () => {
  expect((await post('x'.repeat(70_000))).status).toBe(413);
  expect((await post('{не json')).status).toBe(400);
  expect((await post({ update_id: 'x' })).status).toBe(400);
  expect((await post(tgUpdate({ from: 555, text: 'x' }), undefined, 'GET')).status).toBe(405);
});

test('при выключенном боте адрес отвечает 404', async () => {
  setTelegramBotForTests(createTelegramBot({ apiUrl: 'https://api.telegram.org' }));
  expect((await post(tgUpdate({ from: 555, text: 'привет' }))).status).toBe(404);
});
