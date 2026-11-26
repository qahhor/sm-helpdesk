import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Сессии пользователя: список устройств и завершение сессии на другом устройстве (ТЗ 14.3).
// Клиент свой у каждого прогона: завершение чужих сессий общей персоны сломало бы другие тесты.

const sessions = (page: Page) => page.getByRole('main').getByRole('listitem');

test('клиент завершает сессию на другом устройстве', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'кабинет клиента проверяется на телефоне и ноутбуке');
  const claims = { sub: uniqueSub(), name: 'Шахзод', company_id: '501', company_name: 'ACME Trade' };
  await signInAsCustom(page, claims);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signInAsCustom(other, claims);

  await page.goto('/ru/settings');
  await expect(sessions(page)).toHaveCount(2);
  await expect(sessions(page).filter({ hasText: 'Это устройство' })).toHaveCount(1);
  await sessions(page).filter({ hasNotText: 'Это устройство' }).getByRole('button', { name: 'Завершить' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('Сессия завершена');
  await expect(sessions(page)).toHaveCount(1);

  await other.goto('/ru');
  await expect(other).toHaveURL(/\/ru\/login/);
  await otherContext.close();

  // Завершение своей сессии это выход.
  await sessions(page).getByRole('button', { name: 'Завершить' }).click();
  await expect(page).toHaveURL(/\/ru\/login$/);
  await page.goto('/ru');
  await expect(page).toHaveURL(/\/ru\/login/);
});

test('клиент со входом старше 15 минут завершает сессии только после нового входа', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'кабинет клиента проверяется на телефоне и ноутбуке');
  // ASVS 7.5.2, ответ владельца 26.11.2026 (решение 0067): окно то же, что у настроек сотрудников.
  const claims = { sub: uniqueSub(), name: 'Мадина', company_id: '501', company_name: 'ACME Trade' };
  await signInAsCustom(page, claims);
  const otherContext = await browser.newContext();
  await signInAsCustom(await otherContext.newPage(), claims);
  await dbRows(
    `update auth.session set "createdAt" = now() - interval '20 minutes'
     where "userId" = (select "userId" from auth.account where "accountId" = $1)`,
    [claims.sub],
  );

  await page.goto('/ru/settings');
  await page.getByRole('button', { name: 'Завершить все другие сессии' }).click();
  await expect(page).toHaveURL(/session=stale/);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('нужен вход не старше 15 минут');
  await expect(sessions(page)).toHaveCount(2);

  await page.getByRole('button', { name: 'Войти заново' }).click();
  await expect(page).toHaveURL(/\/ru\/login\?reauth=1/);
  await expect(page.getByText('Войдите заново, чтобы продолжить.')).toBeVisible();
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  await page.locator('input[name="claim_sub"]').fill(claims.sub);
  await page.locator('input[name="claim_name"]').fill(claims.name);
  await page.locator('input[name="claim_company_id"]').fill(claims.company_id);
  await page.locator('input[name="claim_company_name"]').fill(claims.company_name);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/ru\/settings$/);

  await page.getByRole('button', { name: 'Завершить все другие сессии' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('Все другие сессии завершены');
  await expect(sessions(page)).toHaveCount(1);
  await otherContext.close();
});

test('сотрудник видит свои сессии в рабочем месте и выходит, завершив текущую', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  await signInStaff(page, staffAccount('care'));
  await page.getByRole('button', { name: /Камила/ }).click();
  await page.getByRole('menuitem', { name: 'Сессии' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/account$/);
  const current = sessions(page).filter({ hasText: 'Это устройство' });
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Chrome');
  await current.getByRole('button', { name: 'Завершить' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login$/);
});
