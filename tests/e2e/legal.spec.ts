import { expect, test } from '@playwright/test';

// Политика обработки данных (раздел 14.6 ТЗ, решение 0017). Утверждённого текста пока нет:
// каталог content/legal/ без manifest.json, политика выключена.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'страницы входа проверяются на телефоне и ноутбуке');
});

test('пока политика не утверждена, страницы и строки о ней нет', async ({ page }) => {
  for (const locale of ['ru', 'uz', 'en']) expect((await page.goto(`/${locale}/legal/privacy`))!.status()).toBe(404);
  await page.goto('/ru/login');
  await expect(page.getByRole('link', { name: 'Политика обработки данных' })).toHaveCount(0);
  await page.goto('/ru/staff/login');
  await expect(page.getByRole('link', { name: 'Политика обработки данных' })).toHaveCount(0);
});

test('страница политики не ставит куки сессии и отвечает без входа', async ({ page }) => {
  const response = await page.request.get('/ru/legal/privacy', { maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(response.headers()['set-cookie'] ?? '').not.toMatch(/session_token/);
});
