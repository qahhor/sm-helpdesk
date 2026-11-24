import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Сценарий S4 "Передача в разработку", ручной режим (ТЗ 7.9, FR-DEV-02, 05; план M8, задача 7): агент второй линии
// передаёт обращение в разработку, вводя номер и ссылку задачи; клиент видит статус "В разработке" и не видит ни
// номера, ни ссылки, ни названия задачи; агент отмечает задачу готовой и получает напоминание сообщить клиенту;
// обращение остаётся "В разработке". База браузерных тестов общая: номер задачи теста с меткой времени.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.use({ storageState: storageStateOf('l2') });

const cleanup = async () => {
  await dbRows(`delete from hdw_dev_task_links where dev_task_id in (select dev_task_id from hdw_dev_tasks where external_id like 'E2E-%')`);
  await dbRows(`delete from hdw_dev_tasks where external_id like 'E2E-%'`);
};
test.beforeAll(cleanup);
test.afterEach(cleanup);

const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);

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
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('S4: вторая линия передаёт обращение в разработку; клиент видит только статус; задача закрыта: агенту напоминание, статус обращения прежний', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const ref = `E2E-${stamp}`;
  const url = `https://tracker.smartup.example/tasks/${ref}`;
  const title = `Накладная не проводится при пустом складе ${stamp}`;
  const number = await clientTicket(browser, `Не проводится накладная ${stamp}`);

  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const details = page.getByRole('complementary', { name: 'Сведения об обращении' });
  const block = details.locator('[data-dev-task]');
  await expect(block).toContainText('Не передано');
  // Из "Нового" перехода в разработку нет: кнопки нет, пока обращение не взято в работу.
  await expect(block.getByRole('button', { name: 'Передать в разработку' })).toHaveCount(0);
  await details.getByRole('button', { name: 'Взять себе' }).click();
  await expect(page).toHaveURL(/done=taken/);

  // Окно передачи: номер, ссылка, название. Открывается и заполняется с клавиатуры.
  const open = block.getByRole('button', { name: 'Передать в разработку' });
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Передать в разработку' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Передать', exact: true })).toBeDisabled();
  await dialog.getByLabel('Номер задачи').fill(ref);
  await dialog.getByLabel('Ссылка на задачу').fill(url);
  await dialog.getByLabel('Название задачи').fill(title);
  expect(await seriousAxe(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Передать', exact: true }).click();
  await expect(page).toHaveURL(/done=dev_sent/);
  await expect(main(page).getByText('Обращение передано в разработку')).toBeVisible();

  // Блок задачи: номер обычной внешней ссылкой, название, статус задачи; статус обращения "В разработке".
  const link = block.getByRole('link', { name: `Задача ${ref}` });
  await expect(link).toHaveAttribute('href', url);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(block).toContainText(title);
  await expect(block).toContainText('Не начата');
  await expect(main(page).locator('[data-event="dev_task"]')).toContainText(`передано в разработку, задача ${ref}`);
  await expect(main(page).locator('[data-event="status"]').last()).toContainText('В работе > В разработке');
  expect(await dbRows(`select status from hdt_tickets where number = $1`, [number])).toEqual([{ status: 'in_development' }]);
  expect(await seriousAxe(page)).toEqual([]);

  // Клиент видит статус "В разработке" и не видит ни номера, ни ссылки, ни названия задачи.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main').getByText('В разработке').first()).toBeVisible();
  const html = await client.content();
  for (const secret of [ref, 'tracker.smartup.example', title, 'Задача разработки', 'передано в разработку']) expect(html).not.toContain(secret);
  await clientContext.close();

  // Агент отмечает задачу готовой и указывает версию.
  await block.getByLabel('Статус задачи').selectOption({ label: 'Готова' });
  await block.getByLabel('Версия с исправлением').fill('5.14.2');
  await block.getByRole('button', { name: 'Сохранить статус' }).click();
  await expect(page).toHaveURL(/done=dev_status/);
  await expect(block).toContainText('Готова');
  await expect(block).toContainText('Версия: 5.14.2');
  await expect(main(page).locator('[data-event="dev_task"]').last()).toContainText(`Задача разработки ${ref} закрыта (Готова)`);
  // Обращение не решается само (FR-DEV-05): статус прежний.
  expect(await dbRows(`select status from hdt_tickets where number = $1`, [number])).toEqual([{ status: 'in_development' }]);
  await expect(main(page).getByText('В разработке').first()).toBeVisible();

  // Напоминание агенту в портале ведёт на обращение.
  await page.goto('/ru/agent/notifications');
  const notice = main(page).getByRole('button', { name: new RegExp(`Задача разработки закрыта: проверьте и сообщите клиенту\\. Обращение SUP-${number}`) });
  await expect(notice).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await notice.click();
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}`));
  // Письмо исполнителю стоит в очереди исходящих, клиенту о закрытии задачи ничего не ушло.
  expect(
    await dbRows(`select o.template from hdn_outbox o join hdt_tickets t on t.ticket_id = o.ticket_id where t.number = $1 and o.template like '%dev_task%'`, [number]),
  ).toEqual([{ template: 'staff_dev_task_closed' }]);
});
