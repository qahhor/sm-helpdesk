import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Карточка известной проблемы (ТЗ 8.12, FR-KP-01..03, 10; план M5c, задача 2): агент второй линии создаёт проблему из
// обращения одним нажатием, публичный текст с названием организации клиента не сохраняется, без названия
// сохраняется, проблема показывается клиентам. Карточка доступна с клавиатуры и без прокрутки страницы вбок на трёх
// ширинах. База браузерных тестов общая: описание обращения с меткой времени.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'три ширины проверяет сам тест');
});
test.use({ storageState: storageStateOf('l2') });
test.describe.configure({ mode: 'serial' });

const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);

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
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('проблема из обращения: перенос полей, проверка публичного текста, показ клиентам; карточка на трёх ширинах', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const number = await clientTicket(browser, `Накладная не проводится ${stamp}`);

  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const block = page.locator('[data-known-problem]');
  await expect(block).toContainText('Не привязано');
  await block.getByRole('button', { name: 'Создать известную проблему' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/problems\/\d+\?status=created/);
  const problem = Number(/problems\/(\d+)/.exec(page.url())?.[1]);
  await expect(main(page).getByText('Проблема создана')).toBeVisible();
  // Внутреннее название из темы обращения, обращение привязано, клиентам не показывается.
  await expect(main(page).getByLabel('Внутреннее название')).toHaveValue(new RegExp(`${stamp}`));
  await expect(page.getByTestId('problem-ticket-count')).toHaveText('1');
  await expect(main(page).getByText('Не показывается клиентам')).toBeVisible();
  expect(await fits(page)).toBe(true);
  expect(await seriousAxe(page)).toEqual([]);

  // Название организации клиента в публичном тексте: не сохраняется (решение 6).
  const ru = main(page).locator('[data-locale="ru"]');
  await ru.getByLabel('Публичное название').fill('Не проводятся накладные');
  await ru.getByLabel('Что происходит').fill('У ACME Trade не проводятся накладные');
  await ru.getByRole('button', { name: 'Сохранить текст' }).click();
  await expect(main(page).getByText('название или ИНН организации')).toBeVisible();
  await page.locator('[data-locale="ru"]').getByLabel('Публичное название').fill('Не проводятся накладные');
  await page.locator('[data-locale="ru"]').getByLabel('Что происходит').fill('После обновления накладные не проводятся. Исправляем.');
  await page.locator('[data-locale="ru"]').getByRole('button', { name: 'Сохранить текст' }).click();
  await expect(main(page).getByText('Текст сохранён')).toBeVisible();
  await main(page).getByRole('button', { name: 'Показать клиентам' }).click();
  await expect(main(page).getByText('Проблема показывается клиентам')).toBeVisible();
  expect(await dbRows(`select show_to_clients from hdp_problems where number = $1`, [problem])).toEqual([{ show_to_clients: true }]);

  // Вкладка "Обращения": привязанное обращение ссылкой.
  await main(page).getByRole('link', { name: /^Обращения 1$/ }).click();
  await expect(page.getByTestId('problem-tickets').getByRole('link', { name: `SUP-${number}` })).toBeVisible();

  // Три ширины: телефон, узкое окно, ноутбук. Страница не прокручивается вбок.
  for (const width of [360, 1100, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/ru/agent/problems/${problem}`);
    await expect(page.getByTestId('agent-problem')).toBeVisible();
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  testInfo.annotations.push({ type: 'problem', description: String(problem) });
});

test('первая линия видит карточку, но не создаёт и не меняет проблему', async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStateOf('l1') });
  const page = await context.newPage();
  const [row] = await dbRows<{ number: string }>(`select number from hdp_problems order by number desc limit 1`);
  test.skip(!row, 'нет проблемы в базе: первый тест не прошёл');
  await page.goto(`/ru/agent/problems/${row!.number}`);
  await expect(page.getByTestId('agent-problem')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сменить статус' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сохранить текст' })).toHaveCount(0);
  await page.goto('/ru/agent/problems');
  await expect(page.getByRole('button', { name: 'Создать проблему' })).toHaveCount(0);
  await context.close();
});
