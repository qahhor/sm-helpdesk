import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { storageStateOf } from './helpers/staff';

const nonceOf = (headers: Record<string, string>) =>
  /'nonce-([^']+)'/.exec(headers['content-security-policy-report-only'] ?? '')?.[1];

test('заголовки на странице', async ({ request }) => {
  const h = (await request.get('/ru')).headers();
  expect(h['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy-report-only']).not.toContain('unsafe-inline');
  expect(h['content-security-policy-report-only']).not.toContain('unsafe-eval');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  expect(h['x-powered-by']).toBeUndefined();
});

test('обработчики /api и файлы тоже идут с nosniff', async ({ request }) => {
  expect((await request.get('/api/health')).headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.get('/brand/tez/tez-icon.svg')).headers()['x-content-type-options']).toBe('nosniff');
});

test('перенаправление на язык тоже идёт с заголовками', async ({ request }) => {
  const res = await request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

test('nonce новый в каждом ответе и не берётся из запроса', async ({ request }) => {
  const a = nonceOf((await request.get('/ru')).headers());
  const b = nonceOf((await request.get('/ru', { headers: { 'x-nonce': 'attacker' } })).headers());
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(b).not.toBe(a);
  expect(b).not.toBe('attacker');
});

test('скрипты страницы подписаны тем же кодом, что в политике', async ({ request }) => {
  const res = await request.get('/ru', { headers: { 'x-nonce': 'attacker' } });
  const nonce = nonceOf(res.headers());
  const html = await res.text();
  const used = [...html.matchAll(/<script[^>]*\snonce="([^"]*)"/g)].map((m) => m[1]);
  expect(used.length).toBeGreaterThan(0);
  expect(new Set(used)).toEqual(new Set([nonce]));
  expect(html).not.toContain('attacker');
});

test('страница не нарушает собственную политику', async ({ browser }) => {
  const violations: string[] = [];
  const watch = (page: import('@playwright/test').Page) =>
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });

  // Кабинет клиента от имени вошедшего клиента.
  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const portal = await client.newPage();
  watch(portal);
  for (const path of ['/ru', '/uz/tickets', '/ru/login']) await portal.goto(path);
  // Меню: содержимое появляется только после нажатия.
  await portal.goto('/ru');
  await portal.getByRole('button', { name: 'Тема' }).click();
  await portal.keyboard.press('Escape');
  await portal.getByRole('banner').getByRole('button', { name: 'Алишер' }).click();
  await portal.keyboard.press('Escape');
  await client.close();

  // Рабочее место открыто только сотрудникам: проверка идёт от имени вошедшего сотрудника.
  const context = await browser.newContext({ storageState: storageStateOf('care') });
  const page = await context.newPage();
  watch(page);
  for (const path of ['/ru/agent', '/en/dev/ui']) await page.goto(path);
  // Нижний лист: содержимое появляется только после нажатия.
  await page.goto('/ru/dev/ui?section=sheet');
  await page.getByRole('button', { name: 'Профиль' }).first().click();
  await page.keyboard.press('Escape');
  await page.goto('/ru/agent');
  await page.getByRole('button', { name: /Камила/ }).click();
  await page.keyboard.press('Escape');
  expect(violations).toEqual([]);
  await context.close();
});

test('запрет встраивания действует на страницах и обработчиках (ревью M9)', async ({ request }) => {
  for (const path of ['/ru', '/api/health'])
    expect((await request.get(path)).headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('адрес с точкой и адрес, похожий на /api, проходят через прокси (ревью M5)', async ({ request }) => {
  const dotted = await request.get('/ru/users/john.doe', { headers: { 'x-nonce': 'attacker' } });
  expect(dotted.status()).toBe(404);
  expect(dotted.headers()['content-security-policy-report-only']).toContain("'nonce-");
  expect(await dotted.text()).not.toContain('attacker');
  const apiLike = await request.get('/api-keys', { maxRedirects: 0 });
  expect(apiLike.status()).toBe(307);
  expect(apiLike.headers().location).toMatch(/\/ru\/api-keys$/);
});
