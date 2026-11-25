import { expect, type Request, test } from '@playwright/test';
import { BUDGET_BYTES, sumScriptBytes } from '../../scripts/checks/budget-rules.mjs';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';

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

test('новое обращение на телефоне загружает не больше 170 КБ скриптов (Lighthouse в кабинет не входит)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request) => {
    pending.push(
      request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })),
    );
  });
  await page.goto('/ru/tickets/new', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новое обращение');
  const total = sumScriptBytes(await Promise.all(pending));
  console.log(`Скрипты нового обращения: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});

test('новая идея на телефоне загружает не больше 170 КБ скриптов (план M7, задача 2)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request) => {
    pending.push(
      request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })),
    );
  });
  await page.goto('/ru/ideas/new', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новая идея');
  const total = sumScriptBytes(await Promise.all(pending));
  console.log(`Скрипты новой идеи: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});

test('доска идей и страница идеи на телефоне загружают не больше 170 КБ скриптов (план M7, задача 5)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const [idea] = await dbRows<{ number: string }>(`select number from hdi_ideas where status = 'open' and published_on is not null order by number desc limit 1`);
  for (const [path, heading] of [
    ['/ru/ideas', 'Идеи'],
    ...(idea ? [[`/ru/ideas/${idea.number}`, null] as const] : []),
  ] as const) {
    const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
    const listener = (request: Request) => {
      pending.push(request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })));
    };
    page.on('requestfinished', listener);
    await page.goto(path, { waitUntil: 'networkidle' });
    if (heading) await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    const total = sumScriptBytes(await Promise.all(pending));
    page.off('requestfinished', listener);
    console.log(`Скрипты ${path}: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
    expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
  }
});
