import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { blockThirdPartyCookies, openHost, useMockContextKeys, widgetFrame, widgetPersona } from './helpers/widget';

// Объявления (ТЗ FR-ANN-01, 02, 04; план M5c, задача 6, решение 24): Customer Care создаёт объявление "сбой" модуля;
// клиент видит его на главной, над формой при выбранном модуле и в панели виджета при модуле из подсказки; закрытие
// убирает баннер у этого пользователя; архив /announcements; в группе (public) баннеров нет. Свой модуль теста, в
// конце объявление заканчивается: база браузерных тестов общая.

test.beforeEach(blockThirdPartyCookies);
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'одно объявление на прогон; ширины проверяет сам тест');
});
test.describe.configure({ mode: 'serial' });

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

const stamp = Date.now().toString(36);
const moduleCode = `e2e-ann-${stamp}`;
const moduleName = `Склад объявлений ${stamp}`;
const title = `Сбой склада ${stamp}`;

test.afterAll(async () => {
  await dbRows(`update hdp_announcements set ends_on = now(), starts_on = least(starts_on, now() - interval '1 second') where announcement_id in (select announcement_id from hdp_announcement_translations where title = $1)`, [title]);
});

test('Customer Care создаёт объявление "сбой" модуля; список показывает его действующим', async ({ browser }) => {
  await dbRows(`insert into hdr_product_modules (code, name) values ($1, $2)`, [moduleCode, JSON.stringify({ ru: moduleName })]);
  const context = await browser.newContext({ storageState: storageStateOf('care') });
  const page = await context.newPage();
  await page.goto('/ru/agent/announcements');
  await page.getByLabel('Вид').selectOption({ label: 'Сбой' });
  await page.getByLabel('Аудитория').selectOption({ label: 'Модуль' });
  await page.getByLabel('Модуль', { exact: true }).selectOption({ label: moduleName });
  await page.getByLabel('Заголовок').first().fill(title);
  await page.getByLabel('Текст').first().fill('Документы склада не проводятся. Исправляем, это займёт около часа.');
  await page.getByRole('button', { name: 'Сохранить объявление' }).click();
  await expect(page.getByText('Объявление сохранено')).toBeVisible();
  await expect(page.getByTestId('agent-announcements')).toContainText(title);
  await expect(page.getByTestId('agent-announcements')).toContainText('Действует');
  expect(await seriousAxe(page)).toEqual([]);
  await context.close();
});

test('клиент: главная, форма при выбранном модуле, архив; закрытие убирает баннер; в (public) баннеров нет', async ({ browser }) => {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await dbRows(`delete from hdp_announcement_dismissals where announcement_id in (select announcement_id from hdp_announcement_translations where title = $1)`, [title]);
  await page.goto('/ru');
  const home = page.getByTestId('announcements-module');
  await expect(home).toContainText(title);
  await expect(home).toContainText('Сбой');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    await expect(page.getByTestId('announcements-module')).toContainText(title);
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);

  // Над формой только при выбранном модуле.
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await expect(page.locator('[data-announcement="outage"]')).toHaveCount(0);
  await page.getByLabel('Модуль', { exact: true }).selectOption({ label: moduleName });
  await expect(page.locator('[data-announcement="outage"]', { hasText: title })).toBeVisible();

  // Архив.
  await page.goto('/ru/announcements');
  await expect(page.getByTestId('announcements-archive')).toContainText(title);

  // Закрытие на главной убирает баннер у этого пользователя.
  await page.goto('/ru');
  await page.getByRole('button', { name: `Закрыть объявление «${title}»` }).click();
  await expect(page.getByTestId('announcements-module')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(title)).toHaveCount(0);

  // Страница входа (группа public) баннеров не показывает.
  const guest = await browser.newContext();
  const login = await guest.newPage();
  await login.goto('/ru/login');
  await expect(login.locator('[data-announcement]')).toHaveCount(0);
  await guest.close();
  await context.close();
});

test('виджет: баннер сбоя при модуле из подсказки, закрытие убирает его', async ({ page }) => {
  const key = await useMockContextKeys();
  await openHost(page, { key, persona: widgetPersona(), hints: { module: moduleCode } });
  await page.evaluate(() => window.SmartupHub.open({ mode: 'report' }));
  const frame = await widgetFrame(page, '/ru/embed/report');
  const banner = frame.getByTestId('widget-announcements');
  await expect(banner).toContainText(title);
  await banner.getByRole('button', { name: `Закрыть объявление «${title}»` }).click();
  await expect(frame.getByTestId('widget-announcements')).toHaveCount(0);
});
