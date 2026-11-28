import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signInAs, signInAsCustom, withOwnAddress } from './helpers/client';
import { dbRows } from './helpers/db';

// Вход клиента через Smartup (FR-ID-01..04, сценарий 1 раздела 15.3 ТЗ в части входа).
const formAlert = (page: Page) => page.getByRole('main').getByRole('alert');

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'вход клиента проверяется на телефоне и ноутбуке');
  // Пределы частоты входа и поиска сервера считаются по адресу посетителя: у каждого теста свой.
  await withOwnAddress(page);
});

test('клиент входит через Smartup, организация создаётся сама', async ({ page }) => {
  await page.goto('/ru/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход в Smartup Hub');
  // Список серверов не раскрывается: на странице нет ни их кодов, ни названий.
  await expect(page.getByText(/mock|Ложный/i)).toHaveCount(0);
  await signInAs(page, 'alisher');
  await expect(page).toHaveURL(/\/ru$/);
  const rows = await dbRows(
    `select o.name, m.role, m.source from hdu_organizations o join hdu_memberships m using (org_id)
     join auth.account a on a."userId" = m.user_id where a."providerId" = 'mock' and a."accountId" = '1001'`,
  );
  expect(rows).toEqual([{ name: 'ACME Trade', role: 'client_user', source: 'smartup' }]);
});

test('новый клиент новой компании: организация и членство появляются при первом входе', async ({ page }, testInfo) => {
  const sub = `e2e-${testInfo.project.name}-${Date.now()}`;
  await signInAsCustom(page, { sub, name: 'Новый клиент', company_id: `c-${sub}`, company_name: `Компания ${sub}` });
  await expect(page).toHaveURL(/\/ru$/);
  expect(await dbRows(`select name from hdu_organizations where external_company_id = $1`, [`c-${sub}`])).toEqual([{ name: `Компания ${sub}` }]);
});

test('клиент выделенного сервера один раз вводит адрес, выбор запоминается', async ({ page }) => {
  await page.goto('/ru/login');
  await page.getByRole('link', { name: 'У нас свой сервер Smartup' }).click();
  await page.getByLabel('Адрес вашего Smartup').fill('localhost:3191');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByRole('link', { name: /Войти через Smartup/ })).toContainText('localhost:3191');
  await page.reload();
  await expect(page.getByRole('link', { name: /Войти через Smartup/ })).toContainText('localhost:3191');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('mock-dedicated');
  await page.goBack();
  await page.getByRole('button', { name: 'Сменить сервер' }).click();
  await expect(page.getByLabel('Адрес вашего Smartup')).toBeVisible();
});

test('неизвестный адрес сервера даёт нейтральное сообщение', async ({ page }) => {
  await page.goto('/ru/login?mode=server');
  await page.getByLabel('Адрес вашего Smartup').fill('unknown.smartup.example');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(formAlert(page)).toContainText('Не нашли такой сервер');
});

test('ошибка возврата с сервера показывает понятное сообщение, а не страницу библиотеки', async ({ page }) => {
  await page.goto('/ru/login?error=state_mismatch');
  await expect(formAlert(page)).toContainText('Не получилось войти через Smartup');
});

test('страница входа на трёх языках без горизонтальной прокрутки, без серьёзных нарушений доступности и CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  for (const path of ['/ru/login', '/uz/login', '/en/login', '/ru/login?mode=server', '/uz/login?mode=server&server=not_found']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
    const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
    expect(serious.map((v) => v.id), path).toEqual([]);
  }
  expect(violations).toEqual([]);
});

test('ошибка начала входа возвращает на страницу входа портала, а не на внутренний адрес сервера', async ({ page, context, baseURL }) => {
  // Кука с неверным кодом сервера: вход не начинается, на сервер по умолчанию не переключается.
  await context.addCookies([{ name: 'hub_server', value: 'BAD!', url: baseURL }]);
  await page.goto('/ru/login/smartup?next=%2Fru');
  await expect(page).toHaveURL(`${baseURL}/ru/login?error=no_server`);
});

test('без ключа проверки "не робот" формы входа работают и виджет не подключается', async ({ page }) => {
  for (const path of ['/ru/login', '/ru/login?mode=link', '/ru/login?mode=server', '/ru/staff/login']) {
    await page.goto(path);
    await expect(page.locator('script[src*="challenges.cloudflare.com"]'), path).toHaveCount(0);
    await expect(page.locator('.cf-turnstile'), path).toHaveCount(0);
  }
});

// Волна 7, T5 (FR-I18N-06; решение 0160): язык профиля после входа на устройстве, где язык не выбирали.
test('после входа на новом устройстве страницы открываются на языке профиля', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'правило одно на всех ширинах');
  const sub = `locale-${Date.now().toString(36)}`;
  const claims = { sub, name: 'Клиент с языком', company_id: `c-${sub}`, company_name: `Компания ${sub}` };
  await signInAsCustom(page, claims);
  await expect(page).toHaveURL(/\/ru$/);
  // Выбор языка в портале запоминается в профиле.
  await page.getByRole('button', { name: 'Русский' }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en(\/|$)/);
  await expect.poll(async () => (await dbRows<{ locale: string }>(`select u.locale from auth."user" u join auth.account a on a."userId" = u.id where a."accountId" = $1`, [sub]))[0]?.locale).toBe('en');

  // Новое устройство: кук нет, вход со страницы на русском. Портал открывает кабинет на языке профиля.
  const device = await browser.newContext();
  const fresh = await device.newPage();
  await signInAsCustom(fresh, claims, { deviceLocale: false });
  await expect(fresh).toHaveURL(/\/en$/);
  await expect(fresh.locator('html')).toHaveAttribute('lang', 'en');
  await device.close();

  // Устройство, где выбран русский, остаётся на русском: выбор на устройстве важнее профиля.
  const chosen = await browser.newContext();
  const pinned = await chosen.newPage();
  await signInAsCustom(pinned, claims);
  await expect(pinned).toHaveURL(/\/ru$/);
  await chosen.close();
});
