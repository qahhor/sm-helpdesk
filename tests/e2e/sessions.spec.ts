import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
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
