import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { totp } from '../helpers/totp';
import { dbRows } from './helpers/db';
import { createStaffInvitation, dropSession, signInStaff, staffAccount, staffCode } from './helpers/staff';

// Вход сотрудников (FR-ID-09): пароль и обязательный второй фактор. Проверяется на ширине ноутбука.
// Сообщение формы. Next.js держит на странице свой элемент с ролью alert для объявлений о переходах,
// поэтому сообщение ищется внутри основного содержимого.
const formAlert = (page: Page) => page.getByRole('main').getByRole('alert');
const formStatus = (page: Page) => page.getByRole('main').getByRole('status');

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'вход сотрудника проверяется в проекте desktop');
});

test('рабочее место без входа перенаправляет на страницу входа сотрудников', async ({ page }) => {
  await page.goto('/ru/agent');
  await expect(page).toHaveURL(/\/ru\/staff\/login\?next=%2Fru%2Fagent$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход для сотрудников');
});

test('сотрудник задаёт пароль, подключает второй фактор и попадает в рабочее место', async ({ page }) => {
  const run = Date.now().toString(36);
  const email = `e2e-new-${run}@smartup.example`;
  const password = `e2e-new-${run}-password`;
  const token = createStaffInvitation({ email, name: 'Новый сотрудник', role: 'agent_l2' });

  await page.goto(`/ru/staff/setup?token=${token}`);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText('Не короче 12 знаков')).toBeVisible();
  // Короткий пароль браузер не отправляет сам, сервер проверяет его ещё раз. Несовпадение видно только серверу.
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveAttribute('minlength', '12');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByLabel('Пароль ещё раз').fill(`${password}-other`);
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(formAlert(page)).toHaveText('Пароли не совпадают.');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByLabel('Пароль ещё раз').fill(password);
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login\?setup=1$/);
  await expect(formStatus(page)).toContainText('Пароль сохранён');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('img', { name: 'QR-код для приложения с кодами' })).toBeVisible();
  await expect(page.getByTestId('totp-secret')).toHaveText(/^[A-Z2-7 ]{16,}$/);

  // Второй фактор ещё не подтверждён: в рабочее место не пускают.
  await page.goto('/ru/agent');
  await expect(page).toHaveURL(/\/ru\/staff\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
  await page.getByLabel('Код из приложения').fill('000000');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(formAlert(page)).toContainText('Код не подошёл');
  await page.getByLabel('Код из приложения').fill(totp(secret));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page).toHaveURL(/\/ru\/agent$/);
  await expect(page.getByRole('button', { name: /Новый сотрудник/ })).toBeVisible();

  // Ссылка приглашения второй раз не работает.
  await page.goto(`/ru/staff/setup?token=${token}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ссылка не действует');
});

test('вход с подключённым вторым фактором и возврат на нужную страницу', async ({ page }) => {
  const care = staffAccount('care');
  await page.goto('/ru/agent');
  await page.getByLabel('Email').fill(care.email);
  await page.getByLabel('Пароль', { exact: true }).fill(care.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  // Шаг кода: до него рабочее место закрыто.
  await expect(page.getByLabel('Код из приложения')).toBeVisible();
  await expect(page.getByTestId('totp-secret')).toHaveCount(0);
  await page.getByLabel('Код из приложения').fill(await staffCode(care));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page).toHaveURL(/\/ru\/agent$/);
  await expect(page.getByRole('button', { name: /Камила/ })).toBeVisible();
});

test('неверный пароль и неизвестный адрес дают одно сообщение', async ({ page }) => {
  for (const email of [staffAccount('l1').email, 'nobody@smartup.example']) {
    await page.goto('/ru/staff/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill('wrong-password-123');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(formAlert(page)).toHaveText('Неверный email или пароль.');
  }
});

test('подменённый адрес возврата не уводит с портала', async ({ page }) => {
  for (const next of ['https%3A%2F%2Fevil.example%2F', '%2F%2Fevil.example', '%2F%5Cevil.example']) {
    // Вошедшего сотрудника страница входа сразу пропускает дальше: каждый вход начинается без сессии.
    await dropSession(page);
    await signInStaff(page, staffAccount('care'), { startAt: `/ru/staff/login?next=${next}` });
    await expect(page, next).toHaveURL(/^http:\/\/localhost:3100\/ru\/agent$/);
  }
});

test('кука сессии недоступна скриптам и привязана к точному адресу', async ({ page, context }) => {
  await signInStaff(page, staffAccount('care'));
  const cookie = (await context.cookies()).find((c) => c.name.endsWith('hub.session_token'));
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', domain: 'localhost', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
});

test('выход завершает сессию', async ({ page }) => {
  await signInStaff(page, staffAccount('care'));
  await page.getByRole('button', { name: /Камила/ }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login$/);
  await page.goto('/ru/agent');
  await expect(page).toHaveURL(/\/ru\/staff\/login\?next=/);
});

test('вход записан в журнал аудита', async ({ page }) => {
  // Учётная запись, под которой параллельно никто успешно не входит: счёт записей точный.
  const care = staffAccount('l1');
  const before = await dbRows<{ n: number }>(
    `select count(*)::int as n from hdc_audit_log a join auth."user" u on u.id::text = a.actor_id where a.action = 'staff.signed_in' and u.email = $1`,
    [care.email],
  );
  await signInStaff(page, care);
  const after = await dbRows<{ n: number }>(
    `select count(*)::int as n from hdc_audit_log a join auth."user" u on u.id::text = a.actor_id where a.action = 'staff.signed_in' and u.email = $1`,
    [care.email],
  );
  expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
});

test('страницы входа сотрудников без серьёзных нарушений доступности и политики CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  const serious = async () =>
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => v.id);

  for (const path of ['/ru/staff/login', '/uz/staff/login', '/en/staff/login', '/ru/staff/setup?token=invalid']) {
    await page.goto(path);
    expect(await serious(), path).toEqual([]);
  }
  const care = staffAccount('care');
  await page.goto('/ru/staff/login');
  await page.getByLabel('Email').fill(care.email);
  await page.getByLabel('Пароль', { exact: true }).fill(care.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Код из приложения')).toBeVisible();
  // Проверка идёт на готовой странице: во время перехода у документа на мгновение нет заголовка, и проверка
  // доступности изредка ловила именно этот момент.
  await expect(page).toHaveTitle(/\S/);
  expect(await serious(), 'шаг кода').toEqual([]);
  expect(violations).toEqual([]);
});
