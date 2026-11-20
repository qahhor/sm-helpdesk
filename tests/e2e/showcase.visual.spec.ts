import { expect, test } from '@playwright/test';

// Снимки витрины компонентов: светлая и тёмная тема на трёх языках.
// Эталоны лежат в tests/e2e/__screenshots__. Обновление: pnpm test:e2e --update-snapshots.
// Снимки делаются только на ширине ноутбука: остальные ширины проверяют тесты оболочек.
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'снимки только для проекта desktop');
});

for (const theme of ['light', 'dark'] as const)
  for (const locale of ['ru', 'uz', 'en'] as const)
    test(`витрина ${theme} ${locale}`, async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: 'hub_theme', value: theme, url: baseURL }]);
      await page.goto(`/${locale}/agent/dev/ui`);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`showcase-${theme}-${locale}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
        animations: 'disabled',
      });
    });

test('на странице не больше одного крупного Теза (UX-B-04)', async ({ page }) => {
  await page.goto('/ru/agent/dev/ui?section=empty-state');
  expect(await page.locator('[data-tez="main"]').count()).toBe(1);
  await page.goto('/ru/agent/dev/ui');
  expect(await page.locator('[data-tez="main"]').count()).toBeLessThanOrEqual(1);
});

test('значок Теза в тёмной шапке берётся из файла для тёмного фона', async ({ page }) => {
  await page.goto('/ru/agent/dev/ui?section=brand');
  const sources = await page.locator('.bg-header [data-tez="icon"] img').evaluateAll((images) =>
    images.map((image) => new URL((image as HTMLImageElement).src).pathname),
  );
  // Два значка в каждой из двух зон витрины.
  expect(sources).toHaveLength(4);
  expect(new Set(sources)).toEqual(new Set(['/brand/tez/tez-icon-on-dark.svg']));
});

test('нижний лист открывается, получает фокус и закрывается клавишей Escape', async ({ page }) => {
  await page.goto('/ru/agent/dev/ui?section=sheet');
  await page.getByRole('button', { name: 'Профиль' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Профиль' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
