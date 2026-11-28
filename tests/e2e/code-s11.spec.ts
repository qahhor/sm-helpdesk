import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { uniqueReport } from '../helpers/code-scan';
import { callOk, e2eMcpClient, seedAgentForE2e } from './helpers/agent';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Сценарий S11 раздела 6 и сценарий 20 раздела 15.3 на отчёте-примере (веха M8c, задача 9; строка приёмки M8c
// раздела 16.2). AI-сотрудник передаёт отчёт о сканировании через сервер MCP, вторая линия утверждает запись;
// сигнатура обращения клиента определяется по утверждённому шаблону. Первая линия передаёт обращение на вторую с
// запиской и видит только "что проверить". Вторая линия видит блок "Что известно по коду", нажимает "Разобрать по
// коду"; AI-сотрудник (тестовый клиент MCP вместо Hermes) пишет внутреннюю заметку анализа, клиент её не видит.
// Сотрудник отвечает клиенту своими словами, создаёт решение из записи и публикует его. Следующий клиент с той же
// ошибкой получает решение подсказкой точным совпадением.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'сценарий проверяется на ноутбуке');
});
test.use({ storageState: storageStateOf('l2') });

const main = (page: Page) => page.getByRole('main');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'kb-suggest%'`);

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

test('сценарий S11: отчёт о сканировании, утверждение, точная сигнатура, "Разобрать по коду", заметка агента, решение из записи для следующего клиента', async ({ page, browser }) => {
  test.setTimeout(360_000);
  const word = `W${Date.now().toString(36)}`;
  const agent = await seedAgentForE2e(['code_catalog_upsert', 'search_code_catalog', 'submit_code_analysis']);
  const mcp = e2eMcpClient(agent.value);
  const report = uniqueReport();
  report.errors[0]!.messageTemplates.ru = `Недостаточно остатка товара {product} на складе {warehouse}, партия ${word}`;
  expect(await callOk(mcp, 'code_catalog_upsert', report)).toMatchObject({ status: 'accepted', added: 3 });
  const key = report.errors[0]!.key;

  // Вторая линия утверждает запись в очереди.
  await page.goto(`/ru/agent/code-knowledge/${encodeURIComponent(key)}`);
  await main(page).getByRole('button', { name: 'Утвердить' }).click();
  await expect(main(page).getByText('Запись утверждена.', { exact: false })).toBeVisible();
  const [entry] = await dbRows<{ signature: string }>(`select signature from hda_code_error_entries where key = $1`, [key]);

  // Клиент сообщает об ошибке: сигнатура обращения определена по утверждённому шаблону (сценарий 20).
  const errorLine = `ORA-20001: Недостаточно остатка товара Молоко 1л на складе Основной, партия ${word}`;
  const number = await clientTicket(browser, `Не сохраняется заказ, выходит ошибка:\n${errorLine}`);
  expect(await dbRows(`select error_signature from hdt_tickets where number = $1`, [number])).toEqual([{ error_signature: entry!.signature }]);

  // Первая линия передаёт обращение на вторую с запиской и видит в блоке только "что проверить".
  const l1Context = await browser.newContext({ storageState: storageStateOf('l1') });
  const l1 = await l1Context.newPage();
  await l1.goto(`/ru/agent/tickets/SUP-${number}`);
  const l1Block = main(l1).locator('[data-code-knowledge]');
  await expect(l1Block).toContainText('Остаток по товару на складе заказа');
  await expect(l1Block).not.toContainText('ORDER_PKG');
  await expect(l1Block.getByRole('button', { name: 'Разобрать по коду' })).toHaveCount(0);
  await l1.getByRole('button', { name: 'Передать на вторую линию' }).click();
  const dialog = l1.getByRole('dialog', { name: 'Передать на вторую линию' });
  await dialog.getByLabel('Причина').selectOption({ label: 'Похоже на ошибку в продукте' });
  await dialog.getByLabel('Что уже проверено').fill('Остаток на складе есть по отчёту');
  await dialog.getByLabel('Что требуется от второй линии').fill('Понять, почему портал пишет про нехватку');
  for (const box of await dialog.getByRole('checkbox').all()) await box.check();
  await dialog.getByRole('button', { name: 'Передать на вторую', exact: true }).click();
  await expect(main(l1).getByRole('status').filter({ hasText: 'Обращение передано на вторую линию' })).toBeVisible();
  await l1Context.close();

  // Вторая линия: блок "Что известно по коду" и "Разобрать по коду".
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const block = main(page).locator('[data-code-knowledge]');
  const card = block.locator(`[data-code-entry="${key}"]`);
  await expect(card).toContainText('утверждено');
  await expect(card).toContainText(report.errors[0]!.conditions);
  await expect(card).toContainText('ORDER_PKG.SAVE_ORDER, db/packages/order_pkg.pkb:412');
  await block.getByRole('button', { name: 'Разобрать по коду' }).click();
  await expect(main(page).getByText('Анализ по коду запрошен.', { exact: false }).first()).toBeVisible();
  await expect(main(page).locator('[data-code-analysis="pending"]')).toContainText('ждём до');
  // Страница обращения сотрудника шире окна на 360 и без блока (известная находка M8b, вне вехи): блок сам не шире
  // своей колонки на трёх ширинах, страница целиком умещается на ноутбуке (раздел 8.1: рабочее место от 1280 px).
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await block.evaluate((el) => el.scrollWidth <= el.clientWidth), `блок, ширина ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await fits(page), 'ширина 1280').toBe(true);
  expect(await seriousAxe(page)).toEqual([]);

  // AI-сотрудник (вместо Hermes) читает сохранённые выводы и пишет внутреннюю заметку анализа.
  expect(await callOk(mcp, 'search_code_catalog', { key })).toMatchObject({ entries: [{ untrusted_key: key, status: 'approved' }] });
  await callOk(mcp, 'submit_code_analysis', {
    ticket_number: number,
    hypothesis: `Заказ на складе Основной больше остатка, контроль остатков включён (${word}).`,
    confidence: 0.75,
    locations: [{ object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 }],
    what_to_check: ['Остаток товара на складе Основной', 'Настройку контроля остатков'],
    questions: ['Какая дата у заказа?'],
    similar_tickets: [],
    recommendation: 'Проверить остаток на дату заказа.',
    entry_keys: [key],
  });
  await page.reload();
  const note = main(page).locator('[data-internal]').filter({ hasText: `Гипотеза причины` }).filter({ hasText: word });
  await expect(note).toBeVisible();
  await expect(note.locator('[data-agent-mark]')).toHaveText('AI-сотрудник, не проверено');
  await expect(note).toContainText('Анализ по коду');
  await expect(main(page).locator('[data-code-analysis="done"]')).toContainText('Анализ готов');

  // Сотрудник отвечает клиенту своими словами.
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByRole('radio', { name: 'Ответ клиенту' }).check();
  await composer.getByLabel('Текст ответа').fill('Проверьте остаток товара на складе Основной на дату заказа.');
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(main(page).locator('article:not([data-internal])').last()).toContainText('Проверьте остаток товара');

  // Клиент видит ответ сотрудника и не видит заметки агента.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(main(client)).toContainText('Проверьте остаток товара');
  await expect(main(client)).not.toContainText('Гипотеза причины');
  await expect(main(client)).not.toContainText('ORDER_PKG');
  await clientContext.close();

  // Решение из записи: черновик без внутренних имён; сотрудник выбирает модуль и аудиторию и публикует.
  await card.getByRole('button', { name: 'Создать решение из записи' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+/);
  const solution = Number(/solutions\/(\d+)/.exec(page.url())?.[1]);
  const [draft] = await dbRows<{ title: string; doc: unknown }>(
    `select v.title, v.doc from hdk_article_versions v join hdk_articles a on a.article_id = v.article_id where a.number = $1 order by v.created_on desc limit 1`,
    [solution],
  );
  expect(draft!.title).toBe(`Недостаточно остатка товара ... на складе ..., партия ${word}`);
  for (const internal of [key, 'ORDER_PKG', 'order_pkg.pkb', 'ORA-20001']) expect(JSON.stringify(draft), internal).not.toContain(internal);
  await dbRows(`insert into hdr_product_modules (code, name) values ('code-s11', '{"ru": "Заказы (знания из кода)"}') on conflict (code) do nothing`);
  await dbRows(`update hdk_articles set audience = 'clients', module_id = (select module_id from hdr_product_modules where code = 'code-s11') where number = $1`, [solution]);
  await page.reload();
  const review = page.getByTestId('solution-review');
  const untrusted = review.getByTestId('solution-untrusted');
  if (await untrusted.count()) for (const box of await untrusted.getByRole('checkbox').all()) await box.check();
  const confirm = review.getByLabel(/Я проверил находки/);
  if (await confirm.count()) await confirm.check();
  await review.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await dbRows<{ n: number }>(`select count(*)::int as n from hdk_search_documents d join hdk_articles a on a.article_id = d.ref_id where a.number = $1`, [solution]))[0]?.n, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Следующий клиент с этой ошибкой получает решение подсказкой точным совпадением.
  await resetLimits();
  const next = await browser.newContext({ storageState: CLIENT_STATE });
  const portal = await next.newPage();
  await portal.goto('/ru/tickets/new');
  await expect(portal.locator('form[data-ready]').first()).toBeAttached();
  await portal.getByLabel('Что случилось?').fill(`Опять ошибка: ORA-20001: Недостаточно остатка товара Хлеб на складе Север, партия ${word}`);
  await expect(portal.getByTestId('suggestions').getByRole('link', { name: `Недостаточно остатка товара ... на складе ..., партия ${word}` })).toBeVisible({ timeout: 30_000 });
  await next.close();
});
