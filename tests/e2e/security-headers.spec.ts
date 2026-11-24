import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { storageStateOf } from './helpers/staff';

const nonceOf = (headers: Record<string, string>) =>
  /'nonce-([^']+)'/.exec(headers['content-security-policy'] ?? '')?.[1];

test('заголовки на странице', async ({ request }) => {
  const h = (await request.get('/ru')).headers();
  // Политика действует, а не только пишет отчёты (аудит 23.11.2026, находка S2; план W0, задача 8).
  expect(h['content-security-policy']).toContain("script-src 'self' 'nonce-");
  expect(h['content-security-policy-report-only']).toBeUndefined();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).not.toContain('unsafe-inline');
  expect(h['content-security-policy']).not.toContain('unsafe-eval');
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
  const watch = async (page: import('@playwright/test').Page) => {
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    // Событие браузера о нарушении: срабатывает и там, где в консоль ничего не пишется.
    await page.exposeFunction('__cspViolation', (text: string) => void violations.push(text));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        void (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI} ${location.pathname}`);
      });
    });
  };

  // Кабинет клиента от имени вошедшего клиента.
  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const portal = await client.newPage();
  await watch(portal);
  for (const path of ['/ru', '/uz/tickets', '/ru/login', '/ru/tickets/new', '/ru/settings', '/ru/notifications', '/ru/org']) await portal.goto(path);
  // Обращение клиента: переписка, вложения, форма ответа.
  await portal.goto('/ru/tickets');
  const own = portal.locator('main a[href*="/tickets/SUP-"]').first();
  if ((await own.count()) > 0) {
    await own.click();
    await portal.waitForURL(/\/tickets\/SUP-\d+/);
  }
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
  await watch(page);
  for (const path of ['/ru/agent', '/en/dev/ui', '/ru/agent/queues', '/ru/agent/organizations', '/ru/agent/account', '/ru/agent/notifications']) await page.goto(path);
  // Обращение в рабочем месте: редактор ответа, шаблоны, история.
  await page.goto('/ru/agent/queues?queue=all');
  const any = page.locator('main a[href*="/agent/tickets/SUP-"]').first();
  await any.click();
  await page.waitForURL(/\/agent\/tickets\/SUP-\d+/);
  await expect(page.getByRole('form', { name: 'Ответ по обращению' })).toHaveAttribute('data-ready', '');
  // Нижний лист: содержимое появляется только после нажатия.
  await page.goto('/ru/dev/ui?section=sheet');
  await page.getByRole('button', { name: 'Профиль' }).first().click();
  await page.keyboard.press('Escape');
  await page.goto('/ru/agent');
  await page.getByRole('button', { name: /Камила/ }).click();
  await page.keyboard.press('Escape');
  expect(violations).toEqual([]);
  // Детектор работает: встроенный скрипт без кода запроса блокируется, и нарушение ловится.
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true';
    document.body.append(script);
  });
  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  await context.close();
});

test('запрет встраивания действует на страницах и обработчиках (ревью M9)', async ({ request }) => {
  for (const path of ['/ru', '/api/health'])
    expect((await request.get(path)).headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('адрес с точкой и адрес, похожий на /api, проходят через прокси (ревью M5)', async ({ request }) => {
  const dotted = await request.get('/ru/users/john.doe', { headers: { 'x-nonce': 'attacker' } });
  expect(dotted.status()).toBe(404);
  expect(dotted.headers()['content-security-policy']).toContain("'nonce-");
  expect(await dotted.text()).not.toContain('attacker');
  const apiLike = await request.get('/api-keys', { maxRedirects: 0 });
  expect(apiLike.status()).toBe(307);
  expect(apiLike.headers().location).toMatch(/\/ru\/api-keys$/);
});
