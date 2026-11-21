import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Рабочее место агента (план M3): очереди, обращение, действия. Проверяется на ноутбуке.
// Сотрудник первой линии из сохранённой сессии, клиент Алишер (ACME Trade) из своей.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.use({ storageState: storageStateOf('l1') });

const resetLimits = () =>
  dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'ticket-reply:user:%' or code like 'ticket-action:user:%'`);

/** Обращение, как его создаёт клиент на портале. Возвращает номер. */
async function clientTicket(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

const main = (page: Page) => page.getByRole('main');

test('очереди: новое обращение клиента в "Новых" со сроком, поиск по номеру, без серьёзных нарушений доступности', async ({ page, browser }) => {
  const description = `Очередь агента ${Date.now()}`;
  const number = await clientTicket(browser, description);
  await page.goto('/ru/agent');
  await main(page).getByRole('link', { name: 'Открыть очереди' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/queues/);
  await expect(main(page).getByRole('link', { name: /^Новые/ })).toHaveAttribute('aria-current', 'page');
  await main(page).getByLabel('Поиск').fill(`SUP-${number}`);
  await main(page).getByRole('button', { name: 'Показать' }).click();
  const row = main(page).locator(`tr[data-number="${number}"]`);
  await expect(row).toContainText(description.slice(0, 20));
  await expect(row).toContainText('ACME Trade');
  // Срок показан текстом и цветом (UX-A-08): у нового обращения он ещё не нарушен.
  await expect(row.locator('[data-sla]')).toHaveAttribute('data-sla', /calm|soon/);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

test('обращение у сотрудника открывается из очереди; клиенту адрес рабочего места отвечает "не найдено"', async ({ page, browser }) => {
  const description = `Страница агента ${Date.now()}`;
  const number = await clientTicket(browser, description);
  await page.goto(`/ru/agent/queues?queue=all&q=SUP-${number}`);
  await main(page).getByRole('link', { name: String(number), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}$`));
  await expect(main(page).locator('article').getByText(description)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Сведения об обращении' })).toContainText('ACME Trade');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  // Клиент по ссылке рабочего места: одинаковое "не найдено", без подсказки, что такой раздел есть.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  expect((await client.goto(`/ru/agent/tickets/SUP-${number}`))?.status()).toBe(404);
  expect((await client.goto('/ru/agent/queues'))?.status()).toBe(404);
  await clientContext.close();
});

test('действия агента: взять себе, подтвердить приоритет с причиной, ждать клиента, отложить; клиент видит только статус', async ({ page, browser }) => {
  const description = `Действия агента ${Date.now()}`;
  const number = await clientTicket(browser, description);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const panel = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await panel.getByRole('button', { name: 'Взять себе' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение у вас' })).toBeVisible();
  await expect(main(page).getByText('В работе', { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Взять себе' })).toHaveCount(0);

  // Приоритет без причины браузер не отправит, с причиной подтверждается и пишется в историю.
  await panel.getByLabel('Приоритет', { exact: true }).selectOption('p1');
  await panel.getByLabel('Причина').fill('Не проводятся накладные у всех агентов');
  await panel.getByRole('button', { name: 'Подтвердить приоритет' }).click();
  await expect(main(page).locator('[data-event="priority"]')).toContainText('Не проводятся накладные у всех агентов');
  await expect(panel.getByRole('button', { name: 'Сменить приоритет' })).toBeVisible();

  await panel.getByLabel('Статус', { exact: true }).selectOption('waiting_customer');
  await panel.getByRole('button', { name: 'Сменить статус' }).click();
  await expect(main(page).getByText('Ждём клиента', { exact: true }).first()).toBeVisible();
  await expect(panel).toContainText('на паузе, ждём клиента');

  await panel.getByRole('button', { name: 'На час' }).click();
  await expect(main(page)).toContainText('отложено до');
  await panel.getByRole('button', { name: 'Вернуть в очередь' }).click();
  await expect(main(page)).not.toContainText('отложено до');

  // Клиент видит смену статуса, но не приоритет, исполнителя и отложение.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).toContainText('Ждём вашего ответа');
  await expect(client.getByRole('main')).not.toContainText('Не проводятся накладные у всех агентов');
  await clientContext.close();
});
