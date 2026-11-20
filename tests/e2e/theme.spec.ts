import { expect, test } from '@playwright/test';

test.describe('в системе включена тёмная тема', () => {
  test.use({ colorScheme: 'dark' });

  test('системная тёмная тема применяется до первой отрисовки', async ({ page }) => {
    await page.goto('/ru', { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('выбранная светлая тема сильнее системной', async ({ page }) => {
    await page.goto('/ru');
    await page.getByRole('button', { name: 'Тема' }).click();
    await page.getByRole('menuitemradio', { name: 'Светлая' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});

test.describe('в системе включена светлая тема', () => {
  test.use({ colorScheme: 'light' });

  test('по умолчанию тема светлая', async ({ page }) => {
    await page.goto('/ru');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('выбор темы запоминается', async ({ page }) => {
    await page.goto('/ru');
    await page.getByRole('button', { name: 'Тема' }).click();
    await page.getByRole('menuitemradio', { name: 'Тёмная' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Тема' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Тёмная' })).toHaveAttribute('aria-checked', 'true');
  });

  test('тёмная тема меняет цвета страницы на значения токенов', async ({ page }) => {
    await page.goto('/ru');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe('rgb(243, 246, 247)');
    await page.getByRole('button', { name: 'Тема' }).click();
    await page.getByRole('menuitemradio', { name: 'Тёмная' }).click();
    await expect.poll(background).toBe('rgb(10, 11, 11)');
  });
});

test('основной текст набран шрифтом Montserrat с сервера портала', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await page.goto('/ru');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/Montserrat/);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.family.includes('Montserrat') && face.status === 'loaded').length,
  );
  expect(loaded).toBeGreaterThan(0);
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).host).toBe(new URL(page.url()).host);
});

test('кабинет клиента: текст 16 px, цель нажатия не меньше 44 px', async ({ page }) => {
  await page.goto('/ru');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('main') as Element).fontSize)).toBe('16px');
  const box = await page.getByRole('button', { name: 'Тема' }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
});
