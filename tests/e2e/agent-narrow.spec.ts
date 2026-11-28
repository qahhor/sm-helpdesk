import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Рабочее место на 360 px (план M9, задача 8, решение 24; долги M8 и M8c): верхняя панель и страница обращения без
// горизонтальной прокрутки у каждой роли, в том числе у обращения с неподтверждённым приоритетом и записями AI.
// Ширина сравнивается с заданной шириной экрана: на телефоне окно раздвигается под слишком широкую страницу.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'ширина телефона');
});

async function clientTicket(browser: Browser): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`Не проводится накладная на складе Основной ${Date.now()}`);
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

/** Самые широкие элементы страницы: для сообщения об ошибке, если страница шире экрана. */
const widest = (page: Page, width: number) =>
  page.evaluate(
    (limit) =>
      [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > limit + 0.5)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} ${Math.round(el.getBoundingClientRect().right)}`),
    width,
  );

for (const role of ['admin', 'l1'] as const)
  test(`360: панель и страница обращения без прокрутки вбок (${role})`, async ({ browser }) => {
    const number = await clientTicket(browser);
    const context = await browser.newContext({ storageState: storageStateOf(role), viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    for (const path of ['/ru/agent', '/ru/agent/queues', `/ru/agent/tickets/SUP-${number}`, `/uz/agent/tickets/SUP-${number}`, `/en/agent/tickets/SUP-${number}`]) {
      await page.goto(path);
      await expect(page.getByRole('banner')).toBeVisible();
      const size = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(size, `${path}: ${(await widest(page, 360)).join('; ')}`).toBeLessThanOrEqual(360);
    }
    await context.close();
  });
