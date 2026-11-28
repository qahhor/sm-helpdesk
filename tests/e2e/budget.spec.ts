import { expect, type Page, type Request, test } from '@playwright/test';
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

async function scriptBytes(page: Page, path: string): Promise<number> {
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request: Request) => {
    pending.push(request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })));
  });
  await page.goto(path, { waitUntil: 'networkidle' });
  const total = sumScriptBytes(await Promise.all(pending));
  console.log(`Скрипты ${path}: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
  return total;
}

test('доска идей на телефоне загружает не больше 170 КБ скриптов (план M7, задача 5)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const total = await scriptBytes(page, '/ru/ideas');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Идеи');
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});

test('страница идеи на телефоне загружает не больше 170 КБ скриптов (план M7, задача 5)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  // Своя опубликованная идея клиента тестов: тест не ждёт, что её оставил другой файл (проверка качества, Q8).
  const [author] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id
       join hdu_organizations o on o.org_id = m.org_id where o.name = 'ACME Trade' and m.state = 'active' order by m.created_on limit 1`,
  );
  expect(author, 'клиент ACME Trade заведён проектом setup').toBeTruthy();
  const [idea] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on) values ($1, $2, $3, 'ru', 'open', now()) returning idea_id, number`,
    [author!.org_id, author!.user_id, author!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', $2, 'Идея для замера скриптов страницы.', repeat('b', 64))`, [
    idea!.idea_id,
    `Замер скриптов ${Date.now()}`,
  ]);
  const total = await scriptBytes(page, `/ru/ideas/${idea!.number}`);
  await expect(page.getByTestId('idea-page')).toBeVisible();
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});

test('отбор месяца на телефоне загружает не больше 170 КБ скриптов (план M7, задача 10)', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const total = await scriptBytes(page, '/ru/ideas/cycles');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Отбор месяца');
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});
