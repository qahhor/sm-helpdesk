import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Исходящие вебхуки (FR-AUTO-10, FR-ADM-11; план M8, задача 5): администратор добавляет адрес и видит секрет подписи
// один раз, проверяет адрес проверочной отправкой, вызывает вебхук действием правила. Приёмник поднимает сам тест
// на 127.0.0.1: портал браузерных тестов работает на localhost, поэтому сетевой слой допускает локальный приёмник.
// База браузерных тестов общая: адрес и правило теста названы с меткой времени и удаляются после теста.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

test.describe.configure({ mode: 'serial' });
const cleanup = async () => {
  await dbRows(`delete from hdw_rules where name like 'E2E Вебхук %'`);
  await dbRows(`delete from hdw_webhook_endpoints where name like 'E2E %'`);
};
test.beforeAll(cleanup);
test.afterEach(cleanup);

type Received = { headers: IncomingHttpHeaders; body: string };
let server: Server | undefined;
test.afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** Приёмник вебхуков: запоминает запросы и отвечает 204. */
async function receiver(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const created = createServer((req, res) => {
    let body = '';
    req.on('data', (piece) => (body += String(piece)));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  server = created;
  await new Promise<void>((done) => created.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(created.address() as AddressInfo).port}/hook`, received };
}

const signedBy = (secret: string, got: Received): boolean => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(got.headers['x-hub-signature']));
  return match !== null && createHmac('sha256', secret).update(`${match[1]}.${got.body}`).digest('hex') === match[2];
};

const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);

/** Обращение, как его создаёт клиент на портале. Возвращает номер. */
async function clientTicket(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await page.getByLabel('Влияние на работу').selectOption({ label: 'Серьёзно мешает' });
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

const main = (page: Page) => page.getByRole('main');
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('администратор добавляет адрес: секрет виден один раз; проверочная отправка и вызов из правила доходят до приёмника с подписью', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const name = `E2E Учёт ${stamp}`;
  const ruleName = `E2E Вебхук ${stamp}`;
  const word = `накладная${stamp}`;
  const hook = await receiver();

  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/webhooks');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Вебхуки' })).toHaveAttribute('aria-current', 'page');
  expect(await seriousAxe(page)).toEqual([]);

  // Новый адрес. Адрес внутренней сети портал не принимает: введённые значения остаются в форме.
  await page.getByRole('link', { name: 'Новый адрес' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/webhooks\/new$/);
  await page.getByLabel('Название', { exact: true }).fill(name);
  await page.getByLabel('Адрес приёмника').fill('https://10.0.0.5/hook');
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Добавить адрес' }).click();
  await expect(main(page).getByRole('alert').first()).toContainText('Адрес не принят');
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue(name);
  expect(await dbRows(`select 1 from hdw_webhook_endpoints where name = $1`, [name])).toEqual([]);
  await page.getByLabel('Адрес приёмника').fill(hook.url);
  await page.getByRole('button', { name: 'Добавить адрес' }).click();

  // Секрет показан один раз, с кнопкой копирования и подсказкой о проверке подписи.
  const shown = main(page).locator('[data-webhook-secret]');
  await expect(shown).toContainText('портал показывает его один раз');
  const secret = (await shown.locator('[data-secret-value]').innerText()).trim();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(shown.getByRole('button', { name: 'Скопировать секрет' })).toBeVisible();
  await expect(shown).toContainText('X-Hub-Signature');
  expect(await seriousAxe(page)).toEqual([]);
  // В базе секрет зашифрован.
  const [stored] = await dbRows<{ endpoint_id: string; sealed: string }>(`select e.endpoint_id, s.sealed from hdw_webhook_endpoints e join hdw_webhook_secrets s using (endpoint_id) where e.name = $1`, [name]);
  expect(stored?.sealed).toMatch(/^v1\./);
  expect(stored?.sealed).not.toContain(secret);

  // После перезагрузки секрета нет: ни на странице создания, ни в списке, ни на странице адреса.
  await page.reload();
  expect(await page.content()).not.toContain(secret);
  await page.goto('/ru/agent/settings/webhooks');
  const row = main(page).locator(`tr[data-webhook="${name}"]`);
  await expect(row).toContainText('Только по правилу автоматизации');
  await expect(row).toContainText('Включён');
  expect(await page.content()).not.toContain(secret);
  await row.getByRole('link', { name: `Открыть адрес ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/agent/settings/webhooks/${stored?.endpoint_id}$`));
  await expect(main(page)).toContainText('Секрет задан. Портал его не показывает.');
  await expect(main(page)).toContainText('Доставок пока нет.');
  expect(await page.content()).not.toContain(secret);
  expect(await seriousAxe(page)).toEqual([]);
  const endpointUrl = page.url();

  // Проверочная отправка: доставка появляется в журнале, приёмник получает подписанный запрос без данных обращений.
  await page.getByRole('button', { name: 'Отправить проверочный запрос' }).click();
  await expect(page).toHaveURL(/done=tested/);
  await expect(main(page).locator('tr[data-delivery="test"]')).toHaveCount(1);
  await expect.poll(() => hook.received.length, { timeout: 90_000, intervals: [500] }).toBe(1);
  const test1 = hook.received[0] as Received;
  expect(test1.headers['x-hub-event']).toBe('test');
  expect(signedBy(secret, test1)).toBe(true);
  expect(JSON.parse(test1.body)).toMatchObject({ event: 'test', ticket: { number: 0 } });
  await expect
    .poll(async () => (await dbRows<{ status: string }>(`select status from hdw_webhook_deliveries where endpoint_id = $1 and kind = 'test'`, [stored?.endpoint_id]))[0]?.status, { timeout: 30_000, intervals: [500] })
    .toBe('sent');
  await page.goto(endpointUrl);
  await expect(main(page).locator('tr[data-delivery="test"]')).toContainText('Доставлено');

  // Смена секрета: окно подтверждения, новый секрет показан один раз, прежний больше не действует.
  await page.getByRole('button', { name: 'Сменить секрет' }).click();
  const dialog = page.getByRole('dialog', { name: `Сменить секрет адреса ${name}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Сменить', exact: true }).click();
  const rotated = (await main(page).locator('[data-webhook-secret] [data-secret-value]').innerText()).trim();
  expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rotated).not.toBe(secret);
  await page.reload();
  expect(await page.content()).not.toContain(rotated);

  // Действие правила "Вызвать вебхук": адрес выбирается из списка администратора.
  await page.goto('/ru/agent/settings/rules/new');
  await page.getByLabel('Название правила').fill(ruleName);
  await page.getByLabel('Событие').selectOption({ label: 'Обращение создано' });
  await page.getByRole('button', { name: 'Условие', exact: true }).click();
  await page.getByLabel('Условие 1: Поле').selectOption({ label: 'Текст обращения' });
  await page.getByLabel('Условие 1: Слова через запятую').fill(word);
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 1: Что сделать').selectOption({ label: 'Вызвать вебхук' });
  await page.getByLabel('Действие 1: Адрес вебхука').selectOption({ label: name });
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/rules\/[0-9a-f-]{36}\?done=created/);
  await expect(page.getByLabel('Действие 1: Адрес вебхука')).toHaveValue(stored?.endpoint_id ?? '');
  await page.goto('/ru/agent/settings/rules');
  await page.getByRole('button', { name: `Включить правило «${ruleName}»` }).click();
  await expect(page).toHaveURL(/done=enabled/);

  const number = await clientTicket(browser, `Не проводится ${word}, покупатель ждёт`);
  await expect.poll(() => hook.received.length, { timeout: 120_000, intervals: [1000] }).toBe(2);
  const called = hook.received[1] as Received;
  expect(called.headers['x-hub-event']).toBe('ticket_created');
  // Подпись новым секретом; тело несёт поля обращения и ни слова из его текста.
  expect(signedBy(rotated, called)).toBe(true);
  expect(signedBy(secret, called)).toBe(false);
  const body = JSON.parse(called.body);
  expect(body).toMatchObject({ event: 'ticket_created', ticket: { number, status: 'new', type: expect.any(String), queue: 'l1' } });
  for (const text of [word, 'проводится', 'покупатель', 'ACME']) expect(called.body.toLowerCase()).not.toContain(text.toLowerCase());

  // Журнал доставок адреса: строка с номером обращения. Секрета на странице нет.
  await page.goto(endpointUrl);
  const delivery = main(page).locator('tr[data-delivery="ticket_created"]');
  await expect(delivery).toContainText(`SUP-${number}`);
  await expect(delivery).toContainText('Обращение создано');
  await expect(main(page).locator('tr[data-delivery]')).toHaveCount(2);
  const html = await page.content();
  expect(html).not.toContain(secret);
  expect(html).not.toContain(rotated);
  // Запись в истории обращения и в журнале правила.
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(main(page).locator('[data-event="rule"]')).toContainText(`Правило «${ruleName}»: вызван вебхук`);

  // Удаление адреса: окно подтверждения, адрес исчезает из списка вместе с журналом доставок.
  await page.goto(endpointUrl);
  await page.getByRole('button', { name: 'Удалить адрес' }).click();
  await page.getByRole('dialog', { name: `Удалить адрес ${name}?` }).getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/webhooks\?done=deleted/);
  await expect(main(page).getByRole('status').first()).toContainText('Адрес удалён');
  await expect(main(page).locator(`tr[data-webhook="${name}"]`)).toHaveCount(0);
  expect(await dbRows(`select 1 from hdw_webhook_deliveries where endpoint_id = $1`, [stored?.endpoint_id])).toEqual([]);
});
