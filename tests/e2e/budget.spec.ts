import { expect, test } from '@playwright/test';
import { BUDGET_BYTES, sumScriptBytes } from '../../scripts/checks/budget-rules.mjs';
import { CLIENT_STATE } from './helpers/client';

// Бюджет скриптов первого экрана (ТЗ 8.9) для главной кабинета: её видит только вошедший клиент,
// поэтому замер идёт здесь, от сохранённой сессии. Страницу входа меряет pnpm budget.
test.use({ storageState: CLIENT_STATE });

test('главная кабинета на телефоне загружает не больше 170 КБ скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request) => {
    pending.push(
      request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })),
    );
  });
  await page.goto('/ru', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/ru$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чем помочь?');
  const total = sumScriptBytes(await Promise.all(pending));
  console.log(`Скрипты главной кабинета: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});
