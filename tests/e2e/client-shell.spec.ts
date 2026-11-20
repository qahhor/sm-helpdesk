import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PAGES = ['', '/tickets', '/ideas', '/settings'];

test.describe('телефон 360', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('нижняя панель из четырёх пунктов с областью нажатия не меньше 44 px', async ({ page }) => {
    await page.goto('/ru');
    const links = page.getByRole('navigation', { name: 'Основное меню' }).getByRole('link');
    await expect(links).toHaveText(['Главная', 'Обращения', 'Идеи', 'Профиль']);
    const boxes = await links.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
    );
    for (const box of boxes) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  });

  test('текущий раздел отмечен не только цветом', async ({ page }) => {
    await page.goto('/ru/ideas');
    const nav = page.getByRole('navigation', { name: 'Основное меню' });
    await expect(nav.locator('[aria-current="page"]')).toHaveText('Идеи');
    await expect(nav.getByRole('link', { name: 'Главная' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('размеры зоны клиента: шапка 52, кнопка не ниже 44, текст 16', async ({ page }) => {
    await page.goto('/ru');
    expect((await page.getByRole('banner').boundingBox())?.height).toBe(52);
    expect(
      (await page.getByRole('link', { name: 'Сообщить о проблеме' }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('main') as Element).fontSize)).toBe('16px');
  });

  for (const locale of ['ru', 'uz', 'en'])
    for (const width of [320, 360])
      test(`нет горизонтальной прокрутки и обрезанных подписей: ${locale}, ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        for (const path of PAGES) {
          await page.goto(`/${locale}${path}`);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const clipped = await page.evaluate(() =>
            [...document.querySelectorAll('nav a, button, h1, h2')]
              .filter((e) => e.scrollWidth > e.clientWidth)
              .map((e) => e.textContent),
          );
          expect(clipped, `${locale}${path}`).toEqual([]);
        }
      });

  test('на первом экране одна главная кнопка (UX-C-01)', async ({ page }) => {
    await page.goto('/ru');
    expect(await page.locator('[data-variant="primary"]').count()).toBe(1);
  });

  test('на странице один крупный Тез (UX-B-04)', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(`/ru${path}`);
      expect(await page.locator('[data-tez="main"]').count()).toBeLessThanOrEqual(1);
    }
  });

  test('нижняя панель не закрывает содержимое', async ({ page }) => {
    await page.goto('/ru');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = await page.locator('main > :last-child').boundingBox();
    const nav = await page.locator('[data-nav="bottom"]').boundingBox();
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(nav?.y ?? 0);
  });
});

test.describe('компьютер 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('навигация в строке, нижней панели нет', async ({ page }) => {
    await page.goto('/ru');
    await expect(page.locator('[data-nav="bottom"]')).toBeHidden();
    await expect(page.locator('[data-nav="top"]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Основное меню' })).toHaveCount(1);
  });

  test('переход по разделам', async ({ page }) => {
    await page.goto('/ru');
    await page.getByRole('navigation', { name: 'Основное меню' }).getByRole('link', { name: 'Обращения' }).click();
    await expect(page).toHaveURL(/\/ru\/tickets$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Обращения');
  });
});

test('с клавиатуры первой доступна ссылка "Перейти к содержимому"', async ({ page }) => {
  await page.goto('/ru');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
});

test('доступность: нет серьёзных и критичных замечаний axe', async ({ page }) => {
  for (const path of ['/ru', '/uz/tickets', '/en/ideas', '/ru/settings']) {
    await page.goto(path);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${path} ${v.id}`),
    ).toEqual([]);
  }
});

test('доступность в тёмной теме', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'hub_theme', value: 'dark', url: baseURL }]);
  await page.goto('/ru');
  await expect(page.locator('html')).toHaveClass(/dark/);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
});

test('страница идёт с запретом кеширования (угроза T4)', async ({ request }) => {
  expect((await request.get('/ru')).headers()['cache-control']).toContain('no-store');
});

test.describe('меню в кабинете клиента на телефоне', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test('пункты меню не ниже 44 px и набраны текстом 16 px (ревью I2)', async ({ page }) => {
    await page.goto('/ru');
    await page.getByRole('button', { name: 'Тема' }).click();
    const item = page.getByRole('menuitemradio', { name: 'Тёмная' });
    expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await item.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
  });
});
