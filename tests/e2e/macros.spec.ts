import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount, storageStateOf } from './helpers/staff';

// Макросы (FR-AG-15, UX-A-16, FR-ADM-10; план M8, задача 6): администратор создаёт макрос "Запросить версию и
// скриншот" (шаблон и статус "Ждём клиента"), агент запускает его на обращении: текст шаблона оказывается в поле
// ответа, статус меняется, в истории запись о макросе. Агент читает текст и отправляет ответ сам.
// База браузерных тестов общая: макрос и шаблон теста названы с меткой времени и удаляются после теста.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

test.describe.configure({ mode: 'serial' });
const cleanup = async () => {
  await dbRows(`delete from hdw_macros where name like 'E2E %'`);
  await dbRows(`delete from hdr_reply_templates where shortcut like 'e2e-macro-%'`);
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

test('администратор создаёт макрос "Запросить версию и скриншот"; агент запускает его: шаблон в поле ответа, статус изменён, в истории запись', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const name = `E2E Запросить версию и скриншот ${stamp}`;
  const title = `E2E версия ${stamp}`;
  const reply = `Пришлите, пожалуйста, версию Smartup и снимок экрана с ошибкой. ${stamp}`;
  await dbRows(`insert into hdr_reply_templates (shortcut, title, body) values ($1, $2, $3)`, [`e2e-macro-${stamp}`, title, JSON.stringify({ ru: reply, uz: reply, en: reply })]);

  // Администратор: раздел "Макросы", редактор с теми же строками действий, что у правил.
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/macros');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Макросы' })).toHaveAttribute('aria-current', 'page');
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole('link', { name: 'Новый макрос' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/macros\/new$/);
  await page.getByLabel('Название макроса').fill(name);
  // Без действий макрос не сохраняется: ошибка объявлена.
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(main(page).getByRole('alert').first()).toContainText('Добавьте хотя бы одно действие');
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await expect(page.getByLabel('Действие 1: Что сделать')).toBeFocused();
  // Вебхука, распределения по кругу и уведомления среди действий макроса нет.
  expect(await page.getByLabel('Действие 1: Что сделать').locator('option').allInnerTexts()).toEqual([
    'Передать на линию',
    'Назначить исполнителя',
    'Сменить приоритет',
    'Добавить тег',
    'Снять тег',
    'Добавить внутреннюю заметку',
    'Вставить шаблон в поле ответа',
    'Отложить',
    'Сменить статус',
  ]);
  await page.getByLabel('Действие 1: Что сделать').selectOption({ label: 'Вставить шаблон в поле ответа' });
  await page.getByLabel('Действие 1: Шаблон').selectOption({ label: title });
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 2: Что сделать').selectOption({ label: 'Сменить статус' });
  await page.getByLabel('Действие 2: Статус').selectOption({ label: 'Ждём клиента' });
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/macros\/[0-9a-f-]{36}\?done=created/);
  await expect(main(page).getByRole('status').first()).toContainText('Макрос создан');
  await expect(page.getByLabel('Название макроса')).toHaveValue(name);
  await expect(page.getByLabel('Действие 2: Статус')).toHaveValue('waiting_customer');
  await page.goto('/ru/agent/settings/macros');
  const row = main(page).locator(`tr[data-macro="${name}"]`);
  await expect(row).toContainText('Вставить шаблон в поле ответа, Сменить статус');
  await expect(row).toContainText('Включён');

  // Агент первой линии открывает обращение клиента и запускает макрос с клавиатуры.
  const number = await clientTicket(browser, `Не открывается отчёт по продажам ${stamp}`);
  const agentContext = await browser.newContext({ storageState: storageStateOf('l1') });
  const agent = await agentContext.newPage();
  await agent.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(agent.locator('form[data-ready]').first()).toBeAttached();
  await expect(agent.getByLabel('Текст ответа')).toHaveValue('');
  const trigger = main(agent).getByRole('button', { name: 'Макросы' });
  await trigger.focus();
  await agent.keyboard.press('Enter');
  const item = agent.getByRole('menuitem', { name });
  await expect(item).toBeVisible();
  expect(await seriousAxe(agent)).toEqual([]);
  await item.focus();
  await agent.keyboard.press('Enter');

  // Итог: что сделано; текст шаблона в поле ответа, но клиенту ещё ничего не ушло.
  const result = main(agent).locator('[data-macro-result]');
  await expect(result).toContainText(`Макрос «${name}» выполнен`);
  await expect(result).toContainText(`Сделано: шаблон «${title}» вставлен в поле ответа; статус Новое > Ждём клиента.`);
  await expect(result).toContainText('Текст шаблона в поле ответа. Проверьте его и отправьте.');
  await expect(agent.getByLabel('Текст ответа')).toHaveValue(reply);
  await expect(main(agent).locator('[data-event="rule"]')).toContainText(`Макрос «${name}»`);
  await expect(main(agent).locator('[data-event="rule"]')).toContainText(`шаблон «${title}» вставлен в поле ответа; статус Новое > Ждём клиента`);
  expect(await dbRows(`select t.status, (select count(*)::int from hdt_ticket_messages m where m.ticket_id = t.ticket_id and m.author_type = 'staff') as replies from hdt_tickets t where t.number = $1`, [number])).toEqual([
    { status: 'waiting_customer', replies: 0 },
  ]);
  expect(await seriousAxe(agent)).toEqual([]);

  // Агент читает текст и отправляет ответ сам.
  await agent.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(agent).toHaveURL(/done=sent/);
  await expect(main(agent).locator('article', { hasText: reply })).toBeVisible();
  expect(await dbRows(`select m.body, m.is_auto, t.status from hdt_ticket_messages m join hdt_tickets t using (ticket_id) where t.number = $1 and m.author_type = 'staff'`, [number])).toEqual([
    { body: reply, is_auto: false, status: 'waiting_customer' },
  ]);
  await agentContext.close();

  // Клиент видит ответ и статус, но не видит ни названия макроса, ни записи о нём.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main').locator('article', { hasText: reply })).toBeVisible();
  const html = await client.content();
  expect(html).not.toContain(name);
  expect(html).not.toContain('Макрос «');
  await clientContext.close();

  // Удаление макроса: окно подтверждения; из меню на странице обращения он исчезает.
  await page.getByRole('link', { name: `Открыть макрос «${name}»` }).click();
  await page.getByRole('button', { name: 'Удалить макрос' }).click();
  await page.getByRole('dialog', { name: `Удалить макрос «${name}»?` }).getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/macros\?done=deleted/);
  await expect(main(page).locator(`tr[data-macro="${name}"]`)).toHaveCount(0);
});

test('агент пишет внутреннюю заметку и запускает макрос с шаблоном: заметка цела и осталась заметкой, шаблон не вставлен (проверка M8, I3)', async ({ browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `E2E Только шаблон ${stamp}`;
  const title = `E2E версия ${stamp}`;
  const reply = `Пришлите, пожалуйста, версию Smartup. ${stamp}`;
  const note = `Клиент должен за два месяца, сроков не обещать ${stamp}`;
  const templateId = (
    await dbRows<{ template_id: string }>(`insert into hdr_reply_templates (shortcut, title, body) values ($1, $2, $3) returning template_id`, [`e2e-macro-${stamp}`, title, JSON.stringify({ ru: reply, uz: reply, en: reply })])
  )[0]!.template_id;
  await dbRows(`insert into hdw_macros (name, actions, order_no) values ($1, $2, 9000)`, [name, JSON.stringify([{ action: 'reply_template', templateId }])]);

  const number = await clientTicket(browser, `Не печатается накладная ${stamp}`);
  const context = await browser.newContext({ storageState: storageStateOf('l1') });
  const agent = await context.newPage();
  await agent.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(agent.locator('form[data-ready]').first()).toBeAttached();
  // Сотрудник пишет внутреннюю заметку: черновик сохранён на сервере как заметка.
  await main(agent).getByRole('radio', { name: 'Внутренняя заметка' }).check();
  await agent.getByLabel('Текст заметки').fill(note);
  await expect(main(agent).getByText('Черновик сохранён')).toBeVisible();

  await main(agent).getByRole('button', { name: 'Макросы' }).click();
  await agent.getByRole('menuitem', { name }).click();
  const result = main(agent).locator('[data-macro-result]');
  await expect(result).toContainText(`Макрос «${name}»: ни одно действие не выполнено`);
  await expect(result.locator('[data-macro-refused]')).toContainText('шаблон не вставлен: в поле ответа вы пишете внутреннюю заметку');
  await expect(result).not.toContainText('Текст шаблона в поле ответа');
  // Поле ответа: тот же текст заметки, режим заметки; на сервере черновик по-прежнему заметка.
  await expect(agent.getByLabel('Текст заметки')).toHaveValue(note);
  await expect(main(agent).getByRole('radio', { name: 'Внутренняя заметка' })).toBeChecked();
  expect(await dbRows(`select d.body, d.is_internal from hdt_reply_drafts d join hdt_tickets t using (ticket_id) where t.number = $1`, [number])).toEqual([{ body: note, is_internal: true }]);
  expect(await seriousAxe(agent)).toEqual([]);
  // После перечитывания страницы черновик тот же: клиенту заметка не ушла.
  await agent.reload();
  await expect(agent.locator('form[data-ready]').first()).toBeAttached();
  await expect(agent.getByLabel('Текст заметки')).toHaveValue(note);
  await expect(main(agent).getByRole('radio', { name: 'Внутренняя заметка' })).toBeChecked();
  expect(await dbRows(`select count(*)::int as n from hdt_ticket_messages m join hdt_tickets t using (ticket_id) where t.number = $1 and m.author_type = 'staff'`, [number])).toEqual([{ n: 0 }]);
  await context.close();
});

test('макрос со старой страницы: клиент написал, макрос ничего не делает, страница называет изменение (FR-AG-12)', async ({ browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `E2E Ждём клиента ${stamp}`;
  await dbRows(`insert into hdw_macros (name, actions, order_no) values ($1, $2, 9000)`, [name, JSON.stringify([{ action: 'set_status', status: 'waiting_customer' }, { action: 'add_note', text: `Заметка макроса ${stamp}` }])]);
  const number = await clientTicket(browser, `Старая страница и макрос ${stamp}`);
  const context = await browser.newContext({ storageState: storageStateOf('l1') });
  const agent = await context.newPage();
  await agent.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(agent.locator('form[data-ready]').first()).toBeAttached();

  // Клиент дописал, пока у сотрудника была открыта страница.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.locator('form[data-ready]').first()).toBeAttached();
  await client.getByLabel('Ответ', { exact: true }).fill('Подождите, ошибка осталась');
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-reply:user:%'`);
  await client.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(client.getByRole('main')).toContainText('Подождите, ошибка осталась');
  await clientContext.close();

  // Макрос со старой страницы: ни статуса, ни заметки; страница перечитана и говорит, что изменилось.
  await main(agent).getByRole('button', { name: 'Макросы' }).click();
  await agent.getByRole('menuitem', { name }).click();
  await expect(agent).toHaveURL(/error=changed&ch=1\.0\.0/);
  await expect(main(agent).getByText('Пока страница была открыта, обращение изменилось')).toBeVisible();
  await expect(main(agent).getByText('новых сообщений: 1')).toBeVisible();
  expect(
    await dbRows(`select t.status, (select count(*)::int from hdt_ticket_messages m where m.ticket_id = t.ticket_id and m.author_type = 'staff') as staff from hdt_tickets t where t.number = $1`, [number]),
  ).toEqual([{ status: 'new', staff: 0 }]);
  // Страница уже свежая: повтор макроса проходит.
  await main(agent).getByRole('button', { name: 'Макросы' }).click();
  await agent.getByRole('menuitem', { name }).click();
  await expect(main(agent).locator('[data-macro-result]')).toContainText(`Макрос «${name}» выполнен`);
  expect((await dbRows(`select status from hdt_tickets where number = $1`, [number]))[0]).toEqual({ status: 'waiting_customer' });
  await context.close();
});
