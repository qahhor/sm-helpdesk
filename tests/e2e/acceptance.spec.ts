import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';

// Кабинет открыт только вошедшему клиенту (FR-ID-05): тесты идут от его сохранённой сессии.
test.use({ storageState: CLIENT_STATE });

// Критерии готовности вехи M0, которые проверяются в браузере.

test('готовность проверяет базу', async ({ request }) => {
  const res = await request.get('/api/ready');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ready', checks: { db: 'ok' } });
});

test('замена палитры меняет вид без правки экранов (UX-S-12)', async ({ page }) => {
  await page.goto('/ru');
  const primary = page.locator('[data-variant="primary"]').first();
  const header = page.getByRole('banner');
  // Значения поставки Smartup Web: основной цвет #027CAA, шапка #072030.
  await expect(primary).toHaveCSS('background-color', 'rgb(2, 124, 170)');
  await expect(header).toHaveCSS('background-color', 'rgb(7, 32, 48)');
  // Меняется только слой 1 токенов: так придёт следующая поставка Smartup Web.
  // Стиль подключается через CSSOM: вставку блока стилей без одноразового кода политика CSP не разрешает.
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(':root { --sm-pri: #AA0277; --sm-header: #301007; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  await expect(primary).toHaveCSS('background-color', 'rgb(170, 2, 119)');
  await expect(header).toHaveCSS('background-color', 'rgb(48, 16, 7)');
});

test('три языка открываются по своим адресам', async ({ request }) => {
  for (const locale of ['ru', 'uz', 'en']) expect((await request.get(`/${locale}`)).status()).toBe(200);
});
