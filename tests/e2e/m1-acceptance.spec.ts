import { expect, test } from '@playwright/test';
import pg from 'pg';
import { signInAs, signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Приёмка вехи M1 (строка M1 раздела 16.2 ТЗ): клиент входит через ложный OIDC и организация создаётся сама,
// сотрудник не входит без второго фактора, запрос без актора возвращает пусто. Плюс границы, которые веха открыла.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'приёмка идёт один раз, на ноутбуке');
});

test('клиент входит через ложный OIDC, организация создаётся сама', async ({ page }) => {
  const sub = uniqueSub();
  const company = `Компания ${sub}`;
  expect(await dbRows(`select 1 from hdu_organizations where name = $1`, [company])).toEqual([]);
  await signInAsCustom(page, { sub, name: 'Новый клиент', company_id: `c-${sub}`, company_name: company });
  await expect(page).toHaveURL(/\/ru$/);
  await expect(page.getByRole('banner')).toContainText(company);
  expect(await dbRows(`select 1 from hdu_organizations where name = $1`, [company])).toHaveLength(1);
});

test('сотрудник не входит без второго фактора', async ({ page }) => {
  const care = staffAccount('care');
  await page.goto('/ru/staff/login');
  await page.getByLabel('Email').fill(care.email);
  await page.getByLabel('Пароль', { exact: true }).fill(care.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Код из приложения')).toBeVisible();
  await page.goto('/ru/agent');
  await expect(page).toHaveURL(/\/ru\/staff\/login/);
});

test('запрос без актора возвращает пусто', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 1 });
  try {
    // Пусто или нет права на таблицу: строк без актора не видно ни в одной.
    for (const table of ['hdu_organizations', 'hdu_memberships', 'hdu_user_profiles', 'hdr_product_modules', 'hdu_servers', 'hdc_audit_log']) {
      const rows = await pool.query(`select * from ${table}`).then(
        (result) => result.rows,
        (error: Error) => (/permission denied/.test(error.message) ? [] : [error.message]),
      );
      expect(rows, table).toEqual([]);
    }
  } finally {
    await pool.end();
  }
});

test('у библиотеки входа снаружи открыт только возврат с сервера Smartup', async ({ request }) => {
  for (const path of ['/api/auth/get-session', '/api/auth/sign-up/email', '/api/auth/sso/register', '/api/auth/list-sessions', '/api/auth/sign-in/email'])
    expect((await request.get(path)).status(), path).toBe(404);
  expect((await request.post('/api/auth/sign-in/email', { data: { email: 'x@y.z', password: 'x' } })).status()).toBe(404);
});

test('серверное действие с чужого сайта отклоняется', async ({ page }) => {
  const email = `csrf-${uniqueSub()}@acme.test`;
  await signInAs(page, 'dilnoza');
  await page.goto('/ru/org');
  // Запрос уходит с заголовком Origin чужого сайта (route.continue этот заголовок не подменяет, route.fetch подменяет).
  let rejected: number | null = null;
  await page.route('**/ru/org', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://evil.example' } });
    rejected = response.status();
    return route.fulfill({ response });
  });
  await page.getByLabel('Email коллеги').fill(email);
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect.poll(() => rejected).not.toBeNull();
  expect(rejected).not.toBe(200);
  expect(await dbRows(`select 1 from hdu_invitations where email = $1`, [email])).toEqual([]);
});

test('страницы входа и кабинета отвечают с заголовками безопасности, кабинет без кеша', async ({ page, request }) => {
  const login = (await request.get('/ru/login')).headers();
  expect(login['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
  expect(login['x-content-type-options']).toBe('nosniff');
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Заголовки', company_id: '501', company_name: 'ACME Trade' });
  const portal = await page.request.get('/ru/settings');
  expect(portal.status()).toBe(200);
  expect(portal.headers()['cache-control']).toContain('no-store');
  expect(portal.headers()['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
});

test('вебхук бота без секретного заголовка отклоняется', async ({ request }) => {
  expect((await request.post('/api/webhooks/telegram', { data: { update_id: 1 } })).status()).toBe(401);
  const wrong = await request.post('/api/webhooks/telegram', {
    data: { update_id: 1 },
    headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret-0123456789abcdef0123456789' },
  });
  expect(wrong.status()).toBe(401);
});

test('настройки рабочего места закрыты для всех, кроме администратора', async ({ page }) => {
  for (const path of ['/ru/agent/settings', '/ru/agent/settings/servers', '/ru/agent/settings/staff', '/ru/agent/settings/audit']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/staff\/login/);
  }
  await signInStaff(page, staffAccount('l1'));
  for (const path of ['/ru/agent/settings', '/ru/agent/settings/staff', '/ru/agent/settings/audit'])
    expect((await page.goto(path))!.status(), path).toBe(404);
});
