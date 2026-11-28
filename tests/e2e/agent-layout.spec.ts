import { expect, test } from '@playwright/test';
import { storageStateOf } from './helpers/staff';
import { createClientTicket } from './helpers/tickets';

// Раскладка рабочего места на ширине ноутбука (проверка интерфейса, U1; раздел 8.4 ТЗ): у страницы обращения
// сведения стоят правой колонкой, у очередей список очередей стоит слева, сводка показателей идёт в четыре колонки.
// Раньше классы lg: и sm: не давали CSS, и всё складывалось в одну колонку.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'раскладка ноутбука проверяется на 1280');
});

test.use({ storageState: storageStateOf('admin') });

test('страница обращения: сведения справа от переписки', async ({ page, browser }) => {
  const number = await createClientTicket(browser);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const aside = page.getByRole('complementary', { name: 'Сведения об обращении' });
  await expect(aside).toBeVisible();
  const asideBox = (await aside.boundingBox())!;
  const mainBox = (await page.locator('main').boundingBox())!;
  // Колонка сведений занимает правую треть и начинается на высоте переписки, а не под ней.
  expect(asideBox.x).toBeGreaterThan(mainBox.x + mainBox.width / 2);
  expect(asideBox.width).toBeLessThan(mainBox.width / 2);
});

test('очереди: список очередей слева от таблицы', async ({ page }) => {
  await page.goto('/ru/agent/queues');
  const nav = page.getByRole('navigation', { name: 'Очереди' });
  const search = page.getByRole('search').first();
  await expect(nav).toBeVisible();
  const navBox = (await nav.boundingBox())!;
  const searchBox = (await search.boundingBox())!;
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(searchBox.x);
  expect(Math.abs(navBox.y - searchBox.y)).toBeLessThan(40);
});

test('показатели: сводка в четыре колонки', async ({ page }) => {
  await page.goto('/ru/agent/metrics');
  const cells = page.locator('section[aria-labelledby="metrics-overview"] dl > *');
  await expect(cells.first()).toBeVisible();
  const tops = await cells.evaluateAll((els) => els.slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(tops).toHaveLength(4);
  expect(new Set(tops).size).toBe(1);
});
