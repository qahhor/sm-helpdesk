import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Правила автоматизации (FR-AUTO-01, 08, 09, 11, FR-ADM-10; план M8, задача 4; сценарий 14 раздела 16 ТЗ):
// администратор создаёт правило в редакторе, проверяет его пробным прогоном, включает; правило срабатывает на новом
// обращении клиента, запись видна в истории обращения и в журнале срабатываний, клиент ничего этого не видит.
// База браузерных тестов общая: правила теста ловят только свои обращения (условие по слову с меткой времени)
// и удаляются после теста, чтобы не трогать обращения других тестов.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

// Тесты файла идут по одному: уборка одного не должна удалить правило другого.
test.describe.configure({ mode: 'serial' });
const cleanup = async () => {
  await dbRows(`delete from hdw_rules where name like 'E2E %'`);
  await dbRows(`delete from hdt_ticket_tags where tag_id in (select tag_id from hdr_tags where name like 'E2E-%')`);
  await dbRows(`delete from hdr_tags where name like 'E2E-%'`);
};
test.beforeAll(cleanup);
test.afterEach(cleanup);

const resetLimits = () =>
  dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'ticket-reply:user:%' or code like 'ticket-action:user:%'`);

/** Обращение, как его создаёт клиент на портале. Возвращает номер. */
async function clientTicket(browser: Browser, description: string, impact: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await page.getByLabel('Влияние на работу').selectOption({ label: impact });
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

const main = (page: Page) => page.getByRole('main');
const details = (page: Page) => page.getByRole('complementary', { name: 'Сведения об обращении' });
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
/** Страница не шире окна: горизонтальной прокрутки нет. */
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Открывает редактор нового правила и задаёт название и условие "текст содержит слово". */
async function startRule(page: Page, name: string, word: string): Promise<void> {
  await page.goto('/ru/agent/settings/rules');
  await page.getByRole('link', { name: 'Новое правило' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/rules\/new$/);
  await page.getByLabel('Название правила').fill(name);
  await page.getByLabel('Событие').selectOption({ label: 'Обращение создано' });
  await page.getByRole('button', { name: 'Условие', exact: true }).click();
  await page.getByLabel('Условие 1: Поле').selectOption({ label: 'Текст обращения' });
  await page.getByLabel('Условие 1: Слова через запятую').fill(word);
}

/** Включает правило в списке. */
async function enableRule(page: Page, name: string): Promise<void> {
  await page.goto('/ru/agent/settings/rules');
  await page.getByRole('button', { name: `Включить правило «${name}»` }).click();
  await expect(page).toHaveURL(/done=enabled/);
  await expect(main(page).locator(`tr[data-rule="${name}"]`)).toContainText('Включено');
}

test('сценарий 14: правило создано, проверено пробным прогоном, включено и сработало; клиент следов правила не видит', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const word = `склад${stamp}`;
  const name = `E2E P1 на вторую линию ${stamp}`;
  const tag = `E2E-${stamp}`;
  await dbRows(`insert into hdr_tags (name) values ($1)`, [tag]);
  // Обращение для пробного прогона: создано до включения правила.
  const before = await clientTicket(browser, `Работа стоит, ${word} не отгружает`, 'Работа остановлена');

  await signInStaff(page, staffAccount('admin'));
  // Список правил: раздел настроек открыт, проверка доступности.
  await page.goto('/ru/agent/settings/rules');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Правила автоматизации' })).toHaveAttribute('aria-current', 'page');
  expect(await seriousAxe(page)).toEqual([]);

  await startRule(page, name, word);
  // Сохранение без действий: сервер отказывает, ошибка объявлена, правило не создано.
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(main(page).getByRole('alert').first()).toContainText('Добавьте хотя бы одно действие');
  await expect(page).toHaveURL(/\/rules\/new$/);

  // Условие "приоритет равно P1": значение выбирается из списка.
  await page.getByRole('button', { name: 'Условие', exact: true }).click();
  await expect(page.getByLabel('Условие 2: Поле')).toBeFocused();
  await page.getByLabel('Условие 2: Поле').selectOption({ label: 'Приоритет' });
  await page.getByLabel('Условие 2: Сравнение').selectOption({ label: 'равно' });
  await page.getByLabel('Условие 2: Значение', { exact: true }).selectOption({ label: 'P1' });
  await page.getByRole('button', { name: 'Условие 2: Значение: Добавить значение' }).click();
  await expect(main(page).locator('[data-condition="2"] [data-picked]')).toHaveText(['P1']);
  // Действия: очередь второй линии и тег. Действие с невыбранным тегом сервер отклоняет с указанием строки.
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 1: Что сделать').selectOption({ label: 'Сменить очередь' });
  await page.getByLabel('Действие 1: Очередь').selectOption({ label: 'Вторая линия' });
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 2: Что сделать').selectOption({ label: 'Добавить тег' });
  await page.getByRole('button', { name: 'Запустить прогон' }).click();
  await expect(main(page).locator('[data-action="2"] [data-issue]')).toContainText('Заполните строку');
  await expect(page.getByLabel('Действие 2: Тег')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Действие 2: Тег').selectOption({ label: tag });
  expect(await seriousAxe(page)).toEqual([]);
  expect(await fitsWidth(page)).toBe(true);

  // Пробный прогон несохранённого правила: подошло одно обращение, видно, что было бы сделано.
  await page.getByRole('button', { name: 'Запустить прогон' }).click();
  const dry = main(page).locator('[data-dry-result]');
  await expect(dry).toContainText('Сработало бы: 1');
  await expect(dry.locator(`[data-dry-match="${before}"]`)).toContainText(`SUP-${before}`);
  await expect(dry.locator(`[data-dry-match="${before}"]`)).toContainText('P1');
  await expect(dry.locator(`[data-dry-match="${before}"]`)).toContainText('ACME Trade');
  await expect(dry.locator(`[data-dry-match="${before}"]`)).toContainText(`очередь Вторая линия; добавлен тег ${tag}`);
  await expect(main(page)).toContainText('Пробный прогон ничего не меняет.');
  // Прогон ничего не изменил: обращение на первой линии, тега и записи о правиле нет, срабатываний нет.
  expect(await dbRows(`select queue, (select count(*)::int from hdt_ticket_tags g where g.ticket_id = t.ticket_id) as tags from hdt_tickets t where number = $1`, [before])).toEqual([{ queue: 'l1', tags: 0 }]);
  expect(await dbRows(`select 1 from hdw_rules where name = $1`, [name])).toEqual([]);

  // Сохранение: правило создано выключенным, открыта его страница с пустым журналом.
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/rules\/[0-9a-f-]{36}\?done=created/);
  await expect(main(page).getByRole('status').first()).toContainText('Правило создано');
  await expect(page.getByLabel('Название правила')).toHaveValue(name);
  await expect(main(page).locator('[data-condition="2"] [data-picked]')).toHaveText(['P1']);
  await expect(page.getByLabel('Действие 2: Тег')).toHaveValue(/[0-9a-f-]{36}/);
  await expect(main(page)).toContainText('Правило ещё не срабатывало.');
  const ruleUrl = page.url().replace(/\?.*$/, '');
  expect(await seriousAxe(page)).toEqual([]);
  // Ширина 1100: редактор и панель прогона помещаются без горизонтальной прокрутки.
  await page.setViewportSize({ width: 1100, height: 800 });
  expect(await fitsWidth(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Выключенное правило не срабатывает; после включения новое обращение P1 обрабатывается фоновым процессом.
  await enableRule(page, name);
  const after = await clientTicket(browser, `Опять ${word}: работа стоит`, 'Работа остановлена');
  await expect
    .poll(async () => (await dbRows<{ queue: string }>(`select queue from hdt_tickets where number = $1`, [after]))[0]?.queue, { timeout: 90_000, intervals: [1000] })
    .toBe('l2');
  await page.goto(`/ru/agent/tickets/SUP-${after}`);
  await expect(details(page)).toContainText('Вторая линия');
  await expect(details(page).locator('[data-ticket-tags] [data-tag]')).toHaveText([tag]);
  await expect(main(page).locator('[data-event="rule"]')).toContainText(`Правило «${name}»: очередь Вторая линия; добавлен тег ${tag}`);
  // Обращение, созданное до включения, правило не тронуло.
  expect(await dbRows(`select queue from hdt_tickets where number = $1`, [before])).toEqual([{ queue: 'l1' }]);

  // Журнал срабатываний правила.
  await page.goto(ruleUrl);
  const run = main(page).locator(`tr[data-run="${after}"]`);
  await expect(run).toContainText(`SUP-${after}`);
  await expect(run).toContainText('Выполнено');
  await expect(run).toContainText(`очередь Вторая линия; добавлен тег ${tag}`);
  await expect(main(page).locator('tr[data-run]')).toHaveCount(1);

  // Клиент на странице обращения не видит ни тега, ни записи о правиле, ни названия правила.
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${after}`);
  await expect(client.getByRole('main').getByText(`Опять ${word}`).first()).toBeVisible();
  const html = await client.content();
  expect(html).not.toContain(tag);
  expect(html).not.toContain(name);
  expect(html).not.toContain('Правило «');
  await clientContext.close();

  // Удаление правила: окно подтверждения, отмена оставляет правило, подтверждение удаляет.
  await page.getByRole('button', { name: 'Удалить правило' }).click();
  const dialog = page.getByRole('dialog', { name: `Удалить правило «${name}»?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Удалить правило' }).click();
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/rules\?done=deleted/);
  await expect(main(page).getByRole('status').first()).toContainText('Правило удалено');
  await expect(main(page).locator(`tr[data-rule="${name}"]`)).toHaveCount(0);
});

test('правило отвечает клиенту по шаблону: ответ помечен как автоматический; порядок правил меняется кнопками', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const word = `касса${stamp}`;
  const name = `E2E Автоответ ${stamp}`;
  const second = `E2E Второе ${stamp}`;
  const title = `E2E версия ${stamp}`;
  const reply = `Пришлите, пожалуйста, версию Smartup и снимок экрана. ${stamp}`;
  await dbRows(`insert into hdr_reply_templates (shortcut, title, body) values ($1, $2, $3)`, [`e2e-${stamp}`, title, JSON.stringify({ ru: reply, uz: reply, en: reply })]);

  await signInStaff(page, staffAccount('admin'));
  await startRule(page, name, word);
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 1: Что сделать').selectOption({ label: 'Ответить клиенту по шаблону' });
  await page.getByLabel('Действие 1: Шаблон').selectOption({ label: title });
  await page.getByLabel('Остановить обработку следующих правил').check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/done=created/);
  await expect(page.getByLabel('Остановить обработку следующих правил')).toBeChecked();

  // Второе правило и порядок: новое правило последнее, кнопка "Выше" меняет его местами с первым.
  await startRule(page, second, `нет${stamp}`);
  await page.getByRole('button', { name: 'Действие', exact: true }).click();
  await page.getByLabel('Действие 1: Что сделать').selectOption({ label: 'Добавить внутреннюю заметку' });
  await page.getByLabel('Действие 1: Текст заметки').fill('Проверить кассу');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/done=created/);
  await page.goto('/ru/agent/settings/rules');
  const order = async () => (await main(page).locator('tr[data-rule]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-rule')))).filter((item) => item === name || item === second);
  expect(await order()).toEqual([name, second]);
  await page.getByRole('button', { name: `Поднять правило «${second}»` }).click();
  await expect(page).toHaveURL(/done=moved/);
  expect(await order()).toEqual([second, name]);

  await enableRule(page, name);
  const number = await clientTicket(browser, `Не печатает чек, ${word}`, 'Серьёзно мешает');
  await expect
    .poll(async () => (await dbRows<{ n: number }>(`select count(*)::int as n from hdt_ticket_messages m join hdt_tickets t using (ticket_id) where t.number = $1 and m.is_auto`, [number]))[0]?.n, {
      timeout: 90_000,
      intervals: [1000],
    })
    .toBe(1);

  // Клиент видит ответ с пометкой "Автоматический ответ".
  const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
  const client = await clientContext.newPage();
  await client.goto(`/ru/tickets/SUP-${number}`);
  const message = client.getByRole('main').locator('article', { hasText: reply });
  await expect(message).toBeVisible();
  await expect(message).toContainText('Автоматический ответ');
  expect(await client.content()).not.toContain(name);
  await clientContext.close();
  // У сотрудника ответ помечен так же, в истории запись о правиле.
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(main(page).locator('[data-event="rule"]')).toContainText(`Правило «${name}»: отправлен автоматический ответ`);
  await dbRows(`delete from hdr_reply_templates where shortcut = $1`, [`e2e-${stamp}`]);
});
