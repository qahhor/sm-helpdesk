import { expect, type Page, test } from '@playwright/test';
import { mailLink } from './helpers/mail';
import { acceptAndEnroll, createStaffInvitation, dropSession, signInStaff, staffAccount } from './helpers/staff';

// Сотрудники в разделе "Настройки" (FR-ADM-03). Общих сотрудников тестов (care, l1, admin) не блокируем:
// для блокировки заводится свой сотрудник через команду hub и страницу задания пароля.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@smartup.example`;

test('администратор приглашает сотрудника, тот задаёт пароль по ссылке из письма', async ({ page, browser }) => {
  const email = uniqueEmail('e2e-l1');
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings');
  await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Сотрудники' }).click();
  await page.getByRole('link', { name: 'Пригласить сотрудника' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Имя').fill('Проверочный');
  await page.getByLabel('Роль').selectOption('agent_l1');
  await page.getByRole('button', { name: 'Отправить приглашение' }).click();
  await expect(main(page).getByRole('status')).toContainText('Приглашение отправляется на почту');
  await expect(page.getByRole('row', { name: new RegExp(email.replace(/[.]/g, '\\.')) })).toContainText('Ждёт ответа');
  // Ссылка администратору не показывается.
  expect(await page.content()).not.toContain('/staff/setup?token=');

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(await mailLink(email, 'staff-invitation'));
  await expect(guest.getByLabel('Пароль', { exact: true })).toBeVisible();
  await guestContext.close();
});

test('заблокированный сотрудник на следующем запросе попадает на страницу входа', async ({ page, browser }) => {
  const email = uniqueEmail('e2e-block');
  const victimContext = await browser.newContext();
  const victim = await victimContext.newPage();
  await acceptAndEnroll(victim, { token: createStaffInvitation({ email, name: 'Блокируемый', role: 'agent_l1' }), email, password: 'e2e-block-password-1' });

  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/staff');
  await page.getByRole('row', { name: new RegExp(email.replace(/[.]/g, '\\.')) }).getByRole('button', { name: 'Управлять' }).click();
  await page.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(main(page)).toContainText('Заблокировать сотрудника Блокируемый?');
  await page.getByRole('button', { name: 'Заблокировать сотрудника' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сотрудник заблокирован');
  await expect(page.getByRole('row', { name: new RegExp(email.replace(/[.]/g, '\\.')) })).toContainText('Заблокирован');

  await victim.goto('/ru/agent');
  await expect(victim).toHaveURL(/\/ru\/staff\/login/);
  await victimContext.close();
});

test('у своей строки нет действий, а care раздел не открывает', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/staff');
  const own = page.getByRole('row', { name: new RegExp(staffAccount('admin').email.replace(/[.]/g, '\\.')) });
  await expect(own).toContainText('это вы');
  await expect(own.getByRole('button')).toHaveCount(0);
  await dropSession(page);
  await signInStaff(page, staffAccount('care'));
  expect((await page.goto('/ru/agent/settings/staff'))!.status()).toBe(404);
});
