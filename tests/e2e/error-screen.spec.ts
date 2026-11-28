import { expect, test } from '@playwright/test';

// Экран ошибки страницы (проверка интерфейса, U6): вместо пустого экрана Next.js показывается оболочка, Тез, текст
// простыми словами на языке адреса и кнопка "Повторить". Причина ошибки на экран не попадает. Ошибку бросает
// проверочная страница витрины /dev/error?fail=1 (только при HUB_SHOWCASE=1).

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'достаточно телефона и ноутбука');
});

const TEXTS = {
  ru: { title: 'Не получилось открыть страницу', retry: 'Повторить' },
  uz: { title: "Sahifani ochib bo'lmadi", retry: 'Takrorlash' },
  en: { title: 'Could not open the page', retry: 'Retry' },
} as const;

for (const [locale, texts] of Object.entries(TEXTS))
  test(`ошибка страницы: оболочка, Тез, текст и кнопки 44 px (${locale})`, async ({ page }) => {
    await page.goto(`/${locale}/dev/error?fail=1`);
    const screen = page.getByTestId('error-screen');
    await expect(screen).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(screen.getByRole('heading', { name: texts.title })).toBeVisible();
    await expect(screen.locator('[data-tez="main"]')).toBeVisible();
    const retry = screen.getByRole('button', { name: texts.retry });
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(screen.getByRole('link')).toHaveAttribute('href', `/${locale}`);
    await expect(page.getByText('проверочная ошибка страницы')).toHaveCount(0);
  });
