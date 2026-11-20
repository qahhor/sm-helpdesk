import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const HEADER_COLOR = 'rgb(7, 32, 48)';
const GROUPS = /^(Работа|Знания|Клиенты|Аналитика|Настройки)$/;

test('1280: тёмная панель 52 px и пять групп', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/ru/agent');
  const bar = page.getByRole('banner');
  expect((await bar.boundingBox())?.height).toBe(52);
  await expect(bar).toHaveCSS('background-color', HEADER_COLOR);
  await expect(bar.getByRole('button', { name: GROUPS })).toHaveText([
    'Работа',
    'Знания',
    'Клиенты',
    'Аналитика',
    'Настройки',
  ]);
});

test('панель тёмная и в тёмной теме', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'hub_theme', value: 'dark', url: baseURL }]);
  await page.goto('/ru/agent');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('banner')).toHaveCSS('background-color', HEADER_COLOR);
});

test('1200 и уже: группы свёрнуты в кнопку "Разделы"', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/ru/agent');
  await expect(page.getByRole('button', { name: 'Работа' })).toBeHidden();
  await page.getByRole('button', { name: 'Разделы' }).click();
  await expect(page.getByRole('menu')).toContainText('Работа');
  await expect(page.getByRole('menu')).toContainText('Настройки');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('1201: группы видны, кнопки "Разделы" нет', async ({ page }) => {
  await page.setViewportSize({ width: 1201, height: 800 });
  await page.goto('/ru/agent');
  await expect(page.getByRole('button', { name: 'Работа' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Разделы' })).toBeHidden();
});

test('группа открывает своё меню', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/ru/agent');
  await page.getByRole('button', { name: 'Знания' }).click();
  await expect(page.getByRole('menu', { name: 'Знания' })).toBeVisible();
});

test('ниже 1024: упрощённый вид', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 800 });
  await page.goto('/ru/agent');
  await expect(page.locator('[data-layout="compact"]')).toHaveCount(1);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.locator('[data-layout="compact"]')).toHaveCount(0);
});

test('длинные узбекские названия групп не ломают панель на 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/uz/agent');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await page.getByRole('banner').boundingBox())?.height).toBe(52);
});

test('страница рабочего места: заголовок, путь и текст 14 px (UX-S-07)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/ru/agent');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Рабочее место');
  await expect(page.getByRole('navigation', { name: 'Путь' })).toContainText('Рабочее место');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('main') as Element).fontSize)).toBe('14px');
});

test('доступность рабочего места', async ({ page }) => {
  await page.goto('/ru/agent');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
});
