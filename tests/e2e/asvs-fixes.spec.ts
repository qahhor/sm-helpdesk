import { expect, test } from '@playwright/test';
import { signInAs } from './helpers/client';
import { acceptAndEnroll, createStaffInvitation, type E2eStaff, signInStaff } from './helpers/staff';

// Исправления по чек-листу ASVS 5.0.0 уровня 2 (план подготовки M9, задача 1; docs/security/asvs.md).

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'проверяется на ширине ноутбука');
});

test('сотрудник меняет пароль на странице учётной записи: все сессии завершены, вход новым паролем (6.2.2, 6.2.3, 7.4.3)', async ({ browser }) => {
  // Свой сотрудник: общие сотрудники тестов не теряют сессий.
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `e2e-password-${run}@smartup.example`;
  const password = `e2e-password-${run}-before`;
  const next = `novyi-parol-${run}-posle-smeny`;
  const token = createStaffInvitation({ email, name: 'Шахзод', role: 'agent_l1' });
  const context = await browser.newContext();
  const page = await context.newPage();
  const totpSecret = await acceptAndEnroll(page, { token, email, password });
  // Вторая сессия того же сотрудника в другом браузере.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const staff: E2eStaff = { key: 'l1', name: 'Шахзод', role: 'agent_l1', email, password, totpSecret };
  await signInStaff(otherPage, staff);

  await page.goto('/ru/agent/account');
  const form = page.getByRole('form', { name: 'Сменить пароль' });
  await expect(page.getByRole('heading', { name: 'Пароль' })).toBeVisible();
  // Неверный текущий пароль: ошибка, ничего не меняется.
  await form.getByLabel('Текущий пароль').fill('not-my-password-123');
  await form.getByLabel('Новый пароль', { exact: true }).fill(next);
  await form.getByLabel('Новый пароль ещё раз').fill(next);
  await form.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(form.getByRole('alert')).toContainText('Текущий пароль неверный.');
  // Частый пароль не принимается.
  await form.getByLabel('Текущий пароль').fill(password);
  await form.getByLabel('Новый пароль', { exact: true }).fill('leavemealone');
  await form.getByLabel('Новый пароль ещё раз').fill('leavemealone');
  await form.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(form.getByRole('alert')).toContainText('Такой пароль слишком частый');
  // Верный: страница входа, обе сессии завершены.
  await form.getByLabel('Текущий пароль').fill(password);
  await form.getByLabel('Новый пароль', { exact: true }).fill(next);
  await form.getByLabel('Новый пароль ещё раз').fill(next);
  await form.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login\?setup=1$/);
  await expect(page.getByText('Пароль сохранён. Войдите с новым паролем.')).toBeVisible();
  await otherPage.goto('/ru/agent');
  await expect(otherPage).toHaveURL(/\/ru\/staff\/login/);
  // Прежний пароль не подходит, новый подходит.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Неверный email или пароль.');
  await signInStaff(page, { ...staff, password: next });
  await expect(page).toHaveURL(/\/ru\/agent$/);
  await context.close();
  await other.close();
});

test('после выхода на устройстве не остаются черновики и другие записи портала (14.3.1)', async ({ page }) => {
  await signInAs(page, 'alisher');
  await page.goto('/ru/tickets/new');
  await page.evaluate(() => {
    window.localStorage.setItem('hub:draft:someone:new-ticket', '{"description":"текст обращения"}');
    window.localStorage.setItem('hub:recent:someone:module', '["m1"]');
    window.sessionStorage.setItem('hub:sent:someone:new-ticket', '{}');
    window.localStorage.setItem('not-portal', 'x');
  });
  await page.getByRole('banner').getByRole('button', { name: 'Алишер' }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/ru\/login/);
  const left = await page.evaluate(() => ({ local: Object.keys(window.localStorage), session: Object.keys(window.sessionStorage) }));
  expect(left.local).toEqual(['not-portal']);
  expect(left.session).toEqual([]);
});
