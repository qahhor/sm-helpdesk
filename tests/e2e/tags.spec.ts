import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Теги обращений (FR-AUTO-13; план M8, задача 1): сотрудник ставит тег на обращении, видит его в очереди и
// отбирает по нему; клиент на странице того же обращения тега не видит. Проверяется на ноутбуке.

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

test('сотрудник ставит тег, видит его в очереди и отбирает по нему; клиент тега не видит', async ({ page, browser }) => {
  const stamp = Date.now();
  const tag = `Тег-${stamp}`;
  const tagged = await clientTicket(browser, `Обращение с тегом ${stamp}`);
  const plain = await clientTicket(browser, `Обращение без тега ${stamp}`);

  await page.goto(`/ru/agent/tickets/SUP-${tagged}`);
  const details = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await details.getByLabel('Добавить тег').fill(tag);
  await details.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page).toHaveURL(/done=tagged/);
  await expect(main(page).getByText('Тег добавлен')).toBeVisible();
  await expect(details.locator('[data-ticket-tags] [data-tag]')).toHaveText([tag]);
  // Постановка тега записана в историю обращения внутренним событием.
  await expect(main(page).locator('[data-event="tag"]')).toContainText(tag);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  // Очередь "Все": тег виден в строке обращения, фильтр по тегу оставляет только его.
  // Строки ищутся по номеру: база браузерных тестов общая, первая страница очереди занята чужими обращениями.
  await page.goto(`/ru/agent/queues?queue=all&q=SUP-${tagged}`);
  await expect(main(page).locator(`tr[data-number="${tagged}"] [data-row-tags]`)).toContainText(tag);
  await page.goto(`/ru/agent/queues?queue=all&q=SUP-${plain}`);
  await expect(main(page).locator(`tr[data-number="${plain}"]`)).toBeVisible();
  await expect(main(page).locator(`tr[data-number="${plain}"] [data-row-tags]`)).toHaveCount(0);
  await page.goto('/ru/agent/queues?queue=all');
  await main(page).getByLabel('Тег', { exact: true }).selectOption({ label: tag });
  await main(page).getByRole('button', { name: 'Показать' }).click();
  await expect(page).toHaveURL(/tag=[0-9a-f-]{36}/);
  await expect(main(page).locator('tbody tr')).toHaveCount(1);
  await expect(main(page).locator(`tr[data-number="${tagged}"]`)).toBeVisible();

  // Клиент на странице того же обращения не видит ни тега, ни события о нём.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${tagged}`);
  await expect(client.getByRole('main').getByText(`Обращение с тегом ${stamp}`).first()).toBeVisible();
  await expect(client.getByText(tag)).toHaveCount(0);
  expect(await client.content()).not.toContain(tag);
  await clientContext.close();

  // Снятие тега: метка уходит со страницы обращения.
  await page.goto(`/ru/agent/tickets/SUP-${tagged}`);
  await details.getByRole('button', { name: `Снять тег ${tag}` }).click();
  await expect(page).toHaveURL(/done=untagged/);
  await expect(details.locator('[data-ticket-tags] [data-tag]')).toHaveCount(0);
});
