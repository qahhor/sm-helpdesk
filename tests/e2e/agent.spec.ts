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
  // Ссылка из очереди несёт очередь и сортировку: по ним "Отправить и к следующему" (FR-AG-17).
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}\\?queue=all&sort=sla$`));
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

test('ответ и заметка: два режима, "Ждём ответа клиента", черновик с другого устройства; клиент видит "Поддержка Smartup" без заметки', async ({ page, browser }) => {
  const number = await clientTicket(browser, `Ответ агента ${Date.now()}`);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');

  await composer.getByRole('radio', { name: 'Внутренняя заметка' }).check();
  await composer.getByLabel('Текст заметки').fill('Проверю логи сервера клиента');
  await composer.getByRole('button', { name: 'Сохранить заметку' }).click();
  await expect(main(page).locator('[data-internal]')).toContainText('Проверю логи сервера клиента');

  await composer.getByRole('radio', { name: 'Ответ клиенту' }).check();
  await composer.getByLabel('Текст ответа').fill('Пришлите, пожалуйста, снимок экрана с ошибкой');
  await composer.getByLabel('Ждём ответа клиента').check();
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(main(page).getByText('Ждём клиента', { exact: true }).first()).toBeVisible();
  await expect(main(page).locator('article:not([data-internal])').last()).toContainText('Пришлите, пожалуйста, снимок экрана');

  // Черновик сохраняется на сервере и открывается на другом устройстве (новая сессия того же сотрудника).
  await composer.getByLabel('Текст ответа').fill('Черновик для другого устройства');
  await expect(composer.getByText('Черновик сохранён')).toBeVisible();
  const other = await browser.newContext({ storageState: storageStateOf('l1') });
  const second = await other.newPage();
  await second.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(second.getByRole('main').getByLabel('Текст ответа')).toHaveValue('Черновик для другого устройства');
  await other.close();

  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).toContainText('Поддержка Smartup');
  await expect(client.getByRole('main')).toContainText('Пришлите, пожалуйста, снимок экрана с ошибкой');
  await expect(client.getByRole('main')).not.toContainText('Проверю логи сервера клиента');
  await expect(client.getByRole('main')).not.toContainText('Азиз');
  await clientContext.close();
});

test('обращение изменилось, пока агент писал: ответ не ушёл, видно что изменилось, "Отправить всё равно" отправляет', async ({ page, browser }) => {
  const number = await clientTicket(browser, `Изменилось ${Date.now()}`);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByLabel('Текст ответа').fill('Ответ, написанный до сообщения клиента');
  // Клиент дописал, пока агент печатал.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.locator('form[data-ready]').first()).toBeAttached();
  await client.getByLabel('Ответ', { exact: true }).fill('Дополнение: ошибка только у одного агента');
  await resetLimits();
  await client.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(client.getByRole('main')).toContainText('Дополнение: ошибка только у одного агента');
  await clientContext.close();

  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  const warning = main(page).getByRole('alert').filter({ hasText: 'Пока вы писали' });
  await expect(warning).toContainText('новых сообщений: 1');
  await expect(main(page).locator('article:not([data-internal])').last()).not.toContainText('Ответ, написанный до сообщения клиента');
  await warning.getByRole('button', { name: 'Отправить всё равно' }).click();
  await expect(main(page).locator('article:not([data-internal])').last()).toContainText('Ответ, написанный до сообщения клиента');
});

test('передача на вторую линию: кнопка неактивна без трёх полей, памятка с флажками, возврат с пояснением; клиент линий не видит', async ({ page, browser }) => {
  // Вторая линия (care) ведёт общую памятку для ошибок.
  const care = await browser.newContext({ storageState: storageStateOf('care') });
  const carePage = await care.newPage();
  await carePage.goto('/ru/agent/playbooks');
  await carePage.getByLabel('Тип обращения').selectOption('bug');
  await carePage.getByLabel('Пункты памятки').fill('- Уточнён период отчёта\n- Проверено на другом пользователе');
  await carePage.getByRole('button', { name: 'Сохранить памятку' }).click();
  await expect(carePage.getByRole('status').filter({ hasText: 'Памятка сохранена' })).toBeVisible();

  const number = await clientTicket(browser, `Передача ${Date.now()}`);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  await page.getByRole('button', { name: 'Передать на вторую линию' }).click();
  const dialog = page.getByRole('dialog', { name: 'Передать на вторую линию' });
  const submit = dialog.getByRole('button', { name: 'Передать на вторую', exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Причина').selectOption({ label: 'Похоже на ошибку в продукте' });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Что уже проверено').fill('Период месяц, у другого пользователя отчёт строится');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Что требуется от второй линии').fill('Проверить права на склады');
  await expect(submit).toBeEnabled();
  await expect(dialog).toContainText('Срок перед клиентом не меняется');
  await dialog.getByLabel('Уточнён период отчёта').check();
  await submit.click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение передано на вторую линию' })).toBeVisible();
  await expect(main(page).locator('[data-event="queue"]')).toContainText('Проверено: Период месяц');
  const details = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await expect(details).toContainText('Линия: Вторая линия');
  await expect(details.locator('[data-pickup]')).toContainText('Взять в работу до');
  await expect(details.getByRole('button', { name: 'Передать на вторую линию' })).toHaveCount(0);

  await carePage.goto(`/ru/agent/tickets/SUP-${number}`);
  await carePage.getByRole('button', { name: 'Вернуть на первую линию' }).click();
  const back = carePage.getByRole('dialog', { name: 'Вернуть на первую линию' });
  await expect(back.getByRole('button', { name: 'Вернуть', exact: true })).toBeDisabled();
  await back.getByLabel('Пояснение для первой линии').fill('Права в порядке, уточните склад у клиента');
  await back.getByRole('button', { name: 'Вернуть', exact: true }).click();
  await expect(carePage.getByRole('main').getByRole('status').filter({ hasText: 'Обращение возвращено на первую линию' })).toBeVisible();
  await care.close();

  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).not.toContainText(/линия|эскалац/i);
  await expect(client.getByRole('main')).not.toContainText('Права в порядке');
  await clientContext.close();
});

test('шаблоны: администратор добавляет, агент набирает "/код" и вставляет текст на языке обращения', async ({ page, browser }) => {
  const code = `e2e-${Date.now().toString(36)}`;
  const admin = await browser.newContext({ storageState: storageStateOf('admin') });
  const adminPage = await admin.newPage();
  await adminPage.goto('/ru/agent/settings/templates');
  const form = adminPage.locator('form').filter({ has: adminPage.getByRole('button', { name: 'Добавить шаблон' }) });
  await form.getByLabel('Код после "/"').fill(code);
  await form.getByLabel('Название').fill('Попросить снимок экрана');
  await form.getByLabel('Текст на русском').fill('Пришлите, пожалуйста, снимок экрана с ошибкой.');
  await form.getByLabel('Текст на узбекском').fill('Iltimos, xato bilan ekran rasmini yuboring.');
  await form.getByRole('button', { name: 'Добавить шаблон' }).click();
  await expect(adminPage.getByRole('status').filter({ hasText: 'Шаблон сохранён' })).toBeVisible();
  await expect(adminPage.getByText(`/${code}`)).toBeVisible();
  await admin.close();

  const number = await clientTicket(browser, `Шаблон ${Date.now()}`);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  const field = composer.getByLabel('Текст ответа');
  await field.click();
  await field.pressSequentially(`Добрый день! /${code.slice(0, 8)}`);
  const list = composer.getByRole('listbox', { name: 'Шаблоны ответов' });
  await expect(list.getByRole('option', { name: new RegExp(code) })).toBeVisible();
  await field.press('Enter');
  await expect(field).toHaveValue('Добрый день! Пришлите, пожалуйста, снимок экрана с ошибкой.');
  await expect(list).toHaveCount(0);
});

test('объединение дублей: дубль закрыт со ссылкой, клиент видит основное и не может открыть дубль заново', async ({ page, browser }) => {
  const mainNumber = await clientTicket(browser, `Основное ${Date.now()}`);
  const dup = await clientTicket(browser, `Дубль ${Date.now()}`);
  await page.goto(`/ru/agent/tickets/SUP-${dup}`);
  await page.getByRole('button', { name: 'Объединить с основным' }).click();
  const dialog = page.getByRole('dialog', { name: 'Объединить дубли' });
  await dialog.getByLabel('Номер основного обращения').fill(`SUP-${mainNumber}`);
  await dialog.getByRole('button', { name: 'Объединить', exact: true }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение закрыто как дубль' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Сведения об обращении' }).locator('[data-merged]')).toContainText(`SUP-${mainNumber}`);

  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${dup}`);
  await expect(client.locator('[data-merged]')).toContainText(`Обращение объединено с SUP-${mainNumber}`);
  await expect(client.getByRole('button', { name: 'Открыть снова' })).toHaveCount(0);
  await client.locator('[data-merged]').getByRole('link').click();
  await expect(client).toHaveURL(new RegExp(`/ru/tickets/SUP-${mainNumber}$`));
  await clientContext.close();
});

test('массовое назначение из очереди: итог по каждому обращению', async ({ page, browser }) => {
  const stamp = `Массовое ${Date.now()}`;
  const first = await clientTicket(browser, `${stamp} первое`);
  const second = await clientTicket(browser, `${stamp} второе`);
  await page.goto(`/ru/agent/queues?queue=all&q=${encodeURIComponent(stamp)}`);
  await main(page).getByLabel(`Выбрать SUP-${first}`).check();
  await main(page).getByLabel(`Выбрать SUP-${second}`).check();
  const bar = main(page).getByRole('form', { name: 'Действия с выбранными' });
  await bar.getByLabel('Действие').selectOption('assign');
  await bar.getByLabel('Исполнитель').selectOption({ label: 'Камила' });
  await bar.getByRole('button', { name: 'Применить к выбранным' }).click();
  await expect(bar.getByRole('status')).toContainText('Готово: 2');
  await expect(main(page).locator(`tr[data-number="${first}"]`)).toContainText('Камила');
  await expect(main(page).locator(`tr[data-number="${second}"]`)).toContainText('Камила');
});

test('обращение за клиента: организация, участник, клиент видит "создал сотрудник поддержки"', async ({ page, browser }) => {
  const description = `Звонок клиента ${Date.now()}: не печатаются накладные`;
  await page.goto('/ru/agent/queues');
  await page.getByRole('link', { name: 'Обращение за клиента' }).click();
  await main(page).getByLabel('Организация: название или ИНН').fill('ACME');
  await main(page).getByRole('button', { name: 'Найти' }).click();
  await main(page).getByRole('link', { name: 'ACME Trade' }).click();
  const author = main(page).getByLabel('От чьего имени');
  await author.selectOption((await author.locator('option', { hasText: 'Алишер' }).first().getAttribute('value')) ?? '');
  await main(page).getByLabel('Что случилось').fill(description);
  await main(page).getByLabel('Приоритет').selectOption('p2');
  await main(page).getByRole('button', { name: 'Создать обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/tickets\/SUP-\d+\?done=created/);
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение создано' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Сведения об обращении' })).toContainText('создано сотрудником');
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);

  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).toContainText(description);
  await expect(client.getByRole('main')).toContainText('создал сотрудник поддержки');
  await clientContext.close();
});

const keysReady = (page: Page) => expect(page.locator('html[data-hotkeys="ready"]')).toHaveCount(1);

test('палитра открывает обращение по номеру и меняет статус', async ({ page, browser }) => {
  const number = await clientTicket(browser, `Палитра ${Date.now()}`);
  await page.goto('/ru/agent/queues');
  await keysReady(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Палитра команд' });
  await palette.getByRole('combobox', { name: 'Команда или номер обращения' }).fill(`SUP-${number}`);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}$`));
  await keysReady(page);
  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('Ждём');
  await expect(palette.getByRole('option', { name: /Статус: Ждём клиента/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(main(page).getByRole('status').filter({ hasText: 'Статус изменён' })).toBeVisible();
  await expect(main(page).getByText('Ждём клиента', { exact: true }).first()).toBeVisible();
});

test('"Отправить и к следующему" открывает следующее обращение очереди', async ({ page, browser }) => {
  const first = await clientTicket(browser, `Следующее A ${Date.now()}`);
  const second = await clientTicket(browser, `Следующее B ${Date.now()}`);
  // Оба у меня; в "Моих" по последнему изменению второе выше первого.
  for (const number of [first, second]) {
    await page.goto(`/ru/agent/tickets/SUP-${number}`);
    await page.getByRole('complementary', { name: 'Сведения об обращении' }).getByRole('button', { name: 'Взять себе' }).click();
    await expect(main(page).getByRole('status').filter({ hasText: 'Обращение у вас' })).toBeVisible();
  }
  await page.goto(`/ru/agent/tickets/SUP-${second}?queue=mine&sort=updated`);
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByLabel('Текст ответа').fill('Готово, проверьте, пожалуйста');
  await composer.getByRole('button', { name: 'Отправить и к следующему' }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${first}\\?queue=mine&sort=updated$`));
});

test('цикл S3 с клавиатуры без мыши', async ({ page, browser }) => {
  const number = await clientTicket(browser, `Клавиатура ${Date.now()}`);
  await page.goto(`/ru/agent/queues?queue=all&q=SUP-${number}`);
  await keysReady(page);
  await page.keyboard.press('ArrowDown');
  await expect(main(page).locator(`tr[data-number="${number}"] [data-row-link]`)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}\\?queue=all`));
  await keysReady(page);
  await page.keyboard.press('t');
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение у вас' })).toBeVisible();
  await keysReady(page);
  await page.keyboard.press('r');
  await expect(main(page).getByLabel('Текст ответа')).toBeFocused();
  await page.keyboard.type('Посмотрели, пришлите снимок экрана');
  await page.keyboard.press('Control+Enter');
  await expect(main(page).getByRole('status').filter({ hasText: 'Ответ отправлен' })).toBeVisible();
  await keysReady(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Палитра команд' }).getByRole('combobox').fill('Ждём');
  await page.keyboard.press('Enter');
  await expect(main(page).getByText('Ждём клиента', { exact: true }).first()).toBeVisible();
  await keysReady(page);
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Клавиши рабочего места' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Клиент отвечает: обращение возвращается в работу (S3, шаг 5).
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.locator('form[data-ready]').first()).toBeAttached();
  await client.getByLabel('Ответ', { exact: true }).fill('Вот снимок');
  await resetLimits();
  await client.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(client.getByRole('main')).toContainText('Вот снимок');
  await clientContext.close();
  await page.reload();
  await expect(main(page).getByText('В работе', { exact: true }).first()).toBeVisible();
});

test('на широком экране список и обращение рядом, стрелка открывает соседнее (UX-A-01)', async ({ page, browser }) => {
  const stamp = `Рядом ${Date.now()}`;
  const first = await clientTicket(browser, `${stamp} одно`);
  const second = await clientTicket(browser, `${stamp} другое`);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/ru/agent/queues?queue=all&sort=updated&q=${encodeURIComponent(stamp)}`);
  await keysReady(page);
  const pane = page.getByRole('complementary', { name: 'Обращение рядом со списком' });
  await expect(pane).toContainText('Выберите обращение');
  await page.keyboard.press('ArrowDown');
  await expect(pane).toContainText(`SUP-${second}`);
  await page.keyboard.press('ArrowDown');
  await expect(pane).toContainText(`SUP-${first}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(pane).toBeHidden();
});

/** Нет прокрутки вбок: содержимое помещается в окно (UX-C-12 для рабочего места). */
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousViolations = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('приёмка M3, сценарий S3: очередь по сроку, взять, приоритет с причиной, заметка, ответ с ожиданием, клиент вернул в работу', async ({ page, browser }) => {
  const description = `S3 ${Date.now()}: не формируется отчёт по остаткам`;
  const number = await clientTicket(browser, description);
  const ticketRow = async () =>
    (
      await dbRows<{ status: string; sla_paused_on: Date | null; sla_paused_minutes: number; resolution_due_on: Date }>(
        `select status, sla_paused_on, sla_paused_minutes, resolution_due_on from hdt_tickets where number = $1`,
        [number],
      )
    )[0];

  // 1. Очередь "Новые" отсортирована по сроку: обращение в ней со сроком.
  await page.goto(`/ru/agent/queues?queue=new&q=SUP-${number}`);
  await expect(main(page).locator(`tr[data-number="${number}"] [data-sla]`)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await main(page).locator(`tr[data-number="${number}"] [data-row-link]`).click();

  // 2. Берёт в работу, уточняет приоритет с причиной.
  const panel = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await panel.getByRole('button', { name: 'Взять себе' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Обращение у вас' })).toBeVisible();
  await panel.getByLabel('Приоритет', { exact: true }).selectOption('p2');
  await panel.getByLabel('Причина').fill('Отчёт нужен для закрытия месяца');
  await panel.getByRole('button', { name: 'Подтвердить приоритет' }).click();
  await expect(main(page).locator('[data-event="priority"]')).toContainText('Отчёт нужен для закрытия месяца');

  // 3. Заметка коллегам и ответ клиенту с "Ждём ответа клиента" (4: срок решения на паузе).
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByRole('radio', { name: 'Внутренняя заметка' }).check();
  await composer.getByLabel('Текст заметки').fill('Похоже на фильтр по складам, проверю права');
  await composer.getByRole('button', { name: 'Сохранить заметку' }).click();
  await expect(main(page).locator('[data-internal]')).toContainText('Похоже на фильтр по складам');
  await composer.getByRole('radio', { name: 'Ответ клиенту' }).check();
  await composer.getByLabel('Текст ответа').fill('Уточните, пожалуйста, какой склад выбран в отчёте');
  await composer.getByLabel('Ждём ответа клиента').check();
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(panel).toContainText('на паузе, ждём клиента');
  const paused = await ticketRow();
  expect(paused?.status).toBe('waiting_customer');
  expect(paused?.sla_paused_on).not.toBeNull();
  expect(await seriousViolations(page)).toEqual([]);

  // 5. Клиент отвечает на портале: обращение возвращается в работу, пауза учтена в сроке. Заметку клиент не видит.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).toContainText('Ждём вашего ответа');
  await expect(client.getByRole('main')).toContainText('Поддержка Smartup');
  await expect(client.getByRole('main')).not.toContainText('Похоже на фильтр по складам');
  await expect(client.locator('form[data-ready]').first()).toBeAttached();
  await client.getByLabel('Ответ', { exact: true }).fill('Склад "Основной"');
  await resetLimits();
  await client.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(client.getByRole('main')).toContainText('Склад "Основной"');
  await clientContext.close();
  await expect.poll(async () => (await ticketRow())?.sla_paused_on === null, { timeout: 15_000 }).toBe(true);
  const resumed = await ticketRow();
  expect(resumed?.status).toBe('in_progress');
  expect(resumed?.resolution_due_on.getTime()).toBeGreaterThanOrEqual(paused?.resolution_due_on.getTime() ?? 0);
  await page.reload();
  await expect(main(page).getByText('В работе', { exact: true }).first()).toBeVisible();

  // Ширина ноутбука при масштабе 200%: окно вдвое уже в точках CSS, прокрутки вбок нет.
  await page.setViewportSize({ width: 640, height: 400 });
  expect(await noSideScroll(page)).toBe(true);
  await page.goto('/ru/agent/queues?queue=all');
  expect(await noSideScroll(page)).toBe(true);
});
