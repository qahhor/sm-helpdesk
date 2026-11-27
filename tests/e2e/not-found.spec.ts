import { expect, test } from '@playwright/test';

// Страница "не найдено" для неизвестного адреса внутри языка (план M9, задача 8, решение 23; решение 0066, пункт 3):
// Next.js собирает её в браузере из документа ошибки, тему применяет ThemeApply. В тёмной теме системы она тёмная,
// выбранная светлая тема сильнее системной, нарушений политики содержимого нет.

const TEXTS = { ru: 'Страница не найдена', uz: 'Sahifa topilmadi', en: 'Page not found' } as const;

for (const [locale, title] of Object.entries(TEXTS))
  test.describe(`язык ${locale}`, () => {
    test.use({ colorScheme: 'dark' });

    test(`404 в тёмной теме тёмная, текст на языке адреса, политика без нарушений (${locale})`, async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => console.error(`Refused to: ${event.violatedDirective}`));
      });
      const response = await page.goto(`/${locale}/net-takoy-stranitsy-${Date.now()}`);
      expect(response?.status()).toBe(404);
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(page.getByRole('link').first()).toHaveAttribute('href', `/${locale}`);
      // Фон страницы из токена тёмной темы, а не белый по умолчанию.
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).not.toBe('rgb(255, 255, 255)');
      expect(response?.headers()['content-security-policy']).toMatch(/script-src 'self' 'nonce-/);
      expect(violations).toEqual([]);
    });
  });

test.describe('выбранная светлая тема', () => {
  test.use({ colorScheme: 'dark' });

  test('сильнее системной тёмной и на странице 404', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'hub_theme', value: 'light', url: baseURL! }]);
    await page.goto(`/ru/net-takoy-stranitsy-${Date.now()}`);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});
