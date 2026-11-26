import { expect, test } from '@playwright/test';

// Фоновый процесс виден снаружи (план подготовки M9, задача 3, решение 5). Фоновый процесс браузерных тестов запущен
// (playwright.config.ts) и отмечается при запуске и раз в минуту: /api/ready/worker отвечает 200. /api/ready не
// изменился: по нему Caddy делит запросы. Ответ 503 по возрасту отметки проверяет tests/integration/worker-heartbeat.test.ts.

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'адреса проверки не зависят от ширины экрана');
});

test('/api/ready/worker: фоновый процесс работает, ответ без подробностей и без кеша', async ({ request }) => {
  // Процесс стартует вместе с порталом: первая отметка может появиться через несколько секунд после портала.
  await expect.poll(async () => (await request.get('/api/ready/worker')).status(), { timeout: 60_000 }).toBe(200);
  const response = await request.get('/api/ready/worker');
  expect(await response.json()).toEqual({ status: 'ready', checks: { worker: 'ok' } });
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('/api/ready прежний: только база, без фонового процесса', async ({ request }) => {
  const response = await request.get('/api/ready');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ready', checks: { db: 'ok' } });
});
