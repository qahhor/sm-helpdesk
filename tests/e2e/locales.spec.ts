import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';

// Кабинет открыт только вошедшему клиенту (FR-ID-05): тесты идут от его сохранённой сессии.
test.use({ storageState: CLIENT_STATE });

const HOME_TITLES = [
  ['ru', 'Чем помочь?'],
  ['uz', 'Sizga qanday yordam kerak?'],
  ['en', 'How can we help?'],
] as const;

for (const [locale, title] of HOME_TITLES) {
  test(`главная на ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  });
}

test('неизвестный язык в адресе ведёт на язык посетителя', async ({ page }) => {
  const res = await page.goto('/de');
  expect(res?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/ru(\/|$)/);
});

test('адрес без языка сохраняет путь', async ({ page }) => {
  await page.goto('/tickets/42');
  await expect(page).toHaveURL(/\/ru\/tickets\/42$/);
});

test.describe('язык браузера узбекский', () => {
  test.use({ locale: 'uz-UZ' });
  test('корень открывается на языке браузера', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/uz(\/|$)/);
  });
});

test('выбранный язык запоминается', async ({ page }) => {
  await page.goto('/ru');
  await page.getByRole('button', { name: 'Русский' }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en(\/|$)/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How can we help?');
  await page.goto('/');
  await expect(page).toHaveURL(/\/en(\/|$)/);
});

test('на странице нет имён ключей вместо текста', async ({ page }) => {
  for (const locale of ['ru', 'uz', 'en']) {
    await page.goto(`/${locale}`);
    await expect(page.locator('body')).not.toContainText(/\b(common|client|agent)\.[a-z]+\./);
  }
});

test('неизвестная страница отвечает 404 на языке адреса', async ({ page }) => {
  const res = await page.goto('/uz/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sahifa topilmadi');
});

test('страницы портала не кешируются (ТЗ 9.4, правило 6)', async ({ page }) => {
  const res = await page.goto('/ru');
  expect(res?.headers()['cache-control']).toMatch(/no-store/);
});
