import { expect, test } from '@playwright/test';
import { signInAs, signInAsCustom, signOutClient } from './helpers/client';
import { signInStaff, staffAccount } from './helpers/staff';

// Кабинет клиента только для участника организации (FR-ID-05, FR-ID-10, ТЗ 9.4).

test('кабинет без входа перенаправляет на страницу входа и возвращает на нужную страницу', async ({ page }) => {
  await page.goto('/ru/tickets');
  await expect(page).toHaveURL(/\/ru\/login\?next=%2Fru%2Ftickets$/);
  await signInAs(page, 'alisher', { startAt: page.url() });
  await expect(page).toHaveURL(/\/ru\/tickets$/);
});

test('страницы кабинета не кешируются, в шапке название организации', async ({ page }) => {
  await signInAs(page, 'alisher');
  const response = await page.goto('/ru');
  expect(response!.headers()['cache-control']).toContain('no-store');
  await expect(page.getByRole('banner')).toContainText('ACME Trade');
});

test('кука сессии продлевается при заходе на страницу', async ({ page, context }) => {
  await signInAs(page, 'alisher');
  const expires = async () => (await context.cookies()).find((c) => c.name.endsWith('hub.session_token'))!.expires;
  const before = await expires();
  await page.waitForTimeout(2000);
  await page.goto('/ru/tickets');
  expect(await expires()).toBeGreaterThan(before);
  expect((await expires()) - Date.now() / 1000).toBeGreaterThan(29 * 86400);
  // Продлённая кука по-прежнему открывает кабинет.
  await page.goto('/ru/ideas');
  await expect(page).toHaveURL(/\/ru\/ideas$/);
});

test('посетитель без сессии не получает куку сессии от прокси', async ({ page, context }) => {
  await page.goto('/ru/login');
  expect((await context.cookies()).filter((c) => c.name.includes('session_token'))).toEqual([]);
});

test('участник двух организаций переключает организацию в шапке', async ({ page }) => {
  const sub = `5${Date.now().toString().slice(-8)}${test.info().parallelIndex}`;
  const first = { company_id: `${sub}1`, company_name: `ACME ${sub}` };
  const second = { company_id: `${sub}2`, company_name: `Globex ${sub}` };
  await signInAsCustom(page, { sub, name: 'Консультант', ...first });
  await signOutClient(page, 'Консультант');
  await signInAsCustom(page, { sub, name: 'Консультант', ...second });
  // Организация последнего входа.
  const banner = page.getByRole('banner');
  await expect(banner).toContainText(second.company_name);
  await banner.getByRole('button', { name: second.company_name }).click();
  await page.getByRole('menuitemradio', { name: first.company_name }).click();
  await expect(banner).toContainText(first.company_name);
  await expect(banner).not.toContainText(second.company_name);
  // Выбор запомнился: новая страница открывается в той же организации.
  await page.goto('/ru/tickets');
  await expect(banner).toContainText(first.company_name);

  // Экран выбора организации: список своих организаций, после выбора открывается страница, куда шёл человек.
  await page.goto('/ru/select-organization?next=%2Fru%2Fideas');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Выберите организацию');
  await page.getByRole('button', { name: new RegExp(second.company_name) }).click();
  await expect(page).toHaveURL(/\/ru\/ideas$/);
  await expect(banner).toContainText(second.company_name);
});

test('пользователь без сведений о компании видит экран "нет организации" и может выйти', async ({ page }) => {
  await signInAs(page, 'nocompany');
  await expect(page).toHaveURL(/\/ru\/no-organization$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Организация не найдена');
  // В кабинет не пускает.
  await page.goto('/ru/tickets');
  await expect(page).toHaveURL(/\/ru\/no-organization$/);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/ru\/login/);
  await page.goto('/ru/no-organization');
  await expect(page).toHaveURL(/\/ru\/login/);
});

test('сотрудник, открывший кабинет клиента, попадает в рабочее место', async ({ page }) => {
  // Вход в новом браузере: сохранённая сессия care для других тестов остаётся.
  // Учётная запись l1 не годится: по ней тест журнала аудита считает входы.
  await signInStaff(page, staffAccount('care'));
  await page.goto('/ru/tickets');
  await expect(page).toHaveURL(/\/ru\/agent$/);
});

test('выход клиента завершает сессию', async ({ page }) => {
  await signInAs(page, 'alisher');
  await signOutClient(page, 'Алишер');
  await page.goto('/ru');
  await expect(page).toHaveURL(/\/ru\/login/);
});
