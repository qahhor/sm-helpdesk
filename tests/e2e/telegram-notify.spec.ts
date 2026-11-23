import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { lastBotMessage, MOCK_TELEGRAM, sendTelegramUpdate, TELEGRAM_WEBHOOK_SECRET, uniqueTelegramId } from './helpers/telegram';

// Приёмка вехи M4b (раздел 16.2 ТЗ): пользователь без email привязывает Telegram, получает уведомление об ответе
// и входит по ссылке из бота, когда вход через Smartup недоступен. Повторная доставка события не создаёт второе
// сообщение. Ложный Telegram на порту 3192, отправку очереди делает фоновый процесс.

test.use({ storageState: storageStateOf('care') });
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');

type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; url?: string }[][] } };
const sentTo = async (chatId: number) => ((await (await fetch(`${MOCK_TELEGRAM}/__sent`)).json()) as Sent[]).filter((m) => m.chat_id === String(chatId));

/** Код привязки: кнопка ведёт на обработчик портала, он перенаправляет в t.me. */
async function linkCode(page: Page): Promise<string> {
  const href = await page.getByRole('link', { name: 'Привязать Telegram' }).getAttribute('href');
  const response = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  return new URL(response.headers().location ?? '').searchParams.get('start') ?? '';
}

/** То же событие Telegram дважды: как повторная доставка вебхука. */
async function postTwice(update: unknown): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const response = await fetch('http://localhost:3100/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify(update),
    });
    expect(response.status).toBe(200);
  }
}

test('сценарий M4b: клиент без email привязывает Telegram, ответ приходит одним сообщением, вход из бота без Smartup', async ({ page, browser }) => {
  const telegramId = uniqueTelegramId();
  const sub = uniqueSub();
  const name = `Без почты ${sub}`;
  const clientContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const client = await clientContext.newPage();
  await signInAsCustom(client, { sub, name, company_id: '501', company_name: 'ACME Trade' });

  // Привязка из профиля: без привязки столбец Telegram есть, но канал не действует.
  await client.goto('/ru/settings');
  await expect(client.getByText('Telegram не привязан.')).toBeVisible();
  await sendTelegramUpdate({ from: telegramId, text: `/start ${await linkCode(client)}` });
  expect((await lastBotMessage(telegramId)).text).toContain('ACME Trade');
  await client.reload();
  await expect(main(client)).toContainText(`Привязан аккаунт @e2e${telegramId}`);
  await expect(client.getByText('Telegram не привязан.')).toHaveCount(0);
  // Уведомление о привязке в портале (FR-NT-13).
  await client.goto('/ru/notifications');
  await expect(main(client)).toContainText('Привязан аккаунт Telegram');
  const { violations } = await new AxeBuilder({ page: client }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);

  // Клиент выключает письма о своих обращениях: Telegram привязан, сервер это разрешает.
  await client.goto('/ru/settings');
  await client.getByRole('checkbox', { name: 'О своих обращениях Почта' }).uncheck();
  await client.getByRole('button', { name: 'Сохранить' }).click();
  await expect(client.getByText('Сохранено')).toBeVisible();
  await expect(client.getByRole('checkbox', { name: 'О своих обращениях Почта' })).not.toBeChecked();
  const settingsAxe = await new AxeBuilder({ page: client }).analyze();
  expect(settingsAxe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);

  // Обращение клиента и ответ сотрудника.
  const [owner] = await dbRows<{ user_id: string; org_id: string }>(
    `select m.user_id, m.org_id from hdu_memberships m join auth."user" u on u.id = m.user_id where u.name = $1 limit 1`,
    [name],
  );
  if (!owner) throw new Error('клиент не найден');
  const [ticket] = await dbRows<{ number: string }>(
    `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source)
     values ($1, $2, 'question', 'minor', 'p3', 'org', $3, 'Проверка уведомления в Telegram', 'ru', 'portal') returning number`,
    [owner.org_id, owner.user_id, `Не печатается накладная ${sub}`],
  );
  const number = Number(ticket?.number);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByRole('radio', { name: 'Ответ клиенту' }).check();
  await composer.getByLabel('Текст ответа').fill(`Секретный ответ ${sub}: перезапустите службу печати`);
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(main(page).locator('article:not([data-internal])').last()).toContainText('перезапустите службу печати');

  // Ровно одно сообщение с номером и кнопкой, без текста ответа.
  await expect.poll(async () => (await sentTo(telegramId)).filter((m) => m.text.includes(`SUP-${number}`)).length, { timeout: 30_000 }).toBe(1);
  const notice = (await sentTo(telegramId)).find((m) => m.text.includes(`SUP-${number}`));
  expect(notice?.text).toContain('Новый ответ поддержки');
  expect(notice?.text).toContain('Не печатается накладная');
  expect(notice?.text).not.toContain('Секретный');
  expect(notice?.reply_markup?.inline_keyboard?.flat()).toEqual([{ text: 'Открыть в портале', url: `http://localhost:3100/ru/tickets/SUP-${number}` }]);
  // Почта о своих обращениях выключена: письма об ответе нет.
  expect(await dbRows(`select 1 from hdn_outbox o join hdt_tickets t on t.ticket_id = o.ticket_id where t.number = $1 and o.channel = 'email'`, [number])).toEqual([]);

  // Повторная доставка события не создаёт второго ответа бота.
  const before = (await sentTo(telegramId)).length;
  const from = { id: telegramId, is_bot: false, first_name: 'Тест', username: `e2e${telegramId}` };
  const updateId = Number(`7${String(Date.now()).slice(-9)}`);
  await postTwice({ update_id: updateId, message: { message_id: 1, from, chat: { id: telegramId, type: 'private' }, text: '/lang' } });
  expect((await sentTo(telegramId)).length).toBe(before + 1);

  // Вход по ссылке из бота в новом браузере, где сервер Smartup недоступен.
  await sendTelegramUpdate({ from: telegramId, text: '/login' });
  const link = (await lastBotMessage(telegramId)).linkButton?.url ?? '';
  const offline = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await offline.route('http://localhost:3190/**', (route) => route.abort());
  const fresh = await offline.newPage();
  await fresh.goto(link);
  await fresh.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(fresh).toHaveURL(/\/ru$/);
  await fresh.goto(`/ru/tickets/SUP-${number}`);
  await expect(main(fresh)).toContainText('перезапустите службу печати');
  await offline.close();
  await clientContext.close();
});
