import { expect, type Page, test } from '@playwright/test';
import { signInAgain, signInAsCustom, signOutClient, uniqueSub, withOwnAddress } from './helpers/client';
import { mailLink } from './helpers/mail';

// Сценарий 2 раздела 15.3 ТЗ: адрес при первом входе, подтверждение, вход по ссылке (FR-ID-06, FR-ID-07).
// У каждого теста свой пользователь Smartup и свой адрес: повторный прогон на той же базе не мешает.

const main = (page: Page) => page.getByRole('main');

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'вход клиента проверяется на телефоне и ноутбуке');
  // Пределы частоты ссылок считаются по адресу посетителя: у каждого теста свой.
  await withOwnAddress(page);
});

test('клиент указывает адрес при первом входе, подтверждает его и входит по ссылке', async ({ page, context }) => {
  const sub = uniqueSub();
  const email = `d${sub}@acme.test`;
  const claims = { sub, name: 'Дильноза', email, company_id: '501', company_name: 'ACME Trade' };
  await signInAsCustom(page, claims, { stopAtWelcome: true });
  await expect(page).toHaveURL(/\/ru\/welcome\?next=%2Fru$/);
  // Адрес из Smartup подставлен, но не подтверждён.
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
  // Обычный вход через Smartup не считается недавним (решение 0083): шаг просит войти заново и после входа
  // возвращается на себя же.
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(main(page).getByRole('alert')).toContainText('подтвердите, что это вы');
  await signInAgain(page, claims);
  await expect(page).toHaveURL(/\/ru\/welcome/);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(main(page).getByRole('status')).toContainText('Мы отправили письмо');

  const confirm = await mailLink(email, 'confirm-email');
  // Почтовый сканер открыл ссылку первым: страница открывается, адрес от этого не подтверждается.
  expect((await context.request.get(confirm)).status()).toBe(200);
  await page.goto(confirm);
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(main(page).getByRole('status')).toContainText('Адрес подтверждён');

  await page.goto('/ru/settings');
  await expect(main(page)).toContainText(`Ссылка для входа приходит на ${email}`);
  await signOutClient(page, 'Дильноза');

  await page.goto('/ru/login');
  await page.getByRole('button', { name: 'Войти по ссылке на email' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Получить ссылку' }).click();
  await expect(main(page).getByRole('status')).toContainText('Если адрес подтверждён');

  const link = await mailLink(email, 'login-link');
  expect(link).toMatch(/^http:\/\/localhost:3100\/ru\/login\/link\?token=/);
  expect((await context.request.get(link)).status()).toBe(200);
  await page.goto(link);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/ru$/);
  await expect(page.getByRole('banner')).toContainText('ACME Trade');

  // Ссылка срабатывает один раз: повторное нажатие даёт понятное сообщение и путь к новой ссылке.
  await page.goto(link);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Ссылка уже не действует');
  await expect(page.getByRole('link', { name: 'Получить новую ссылку' })).toHaveAttribute('href', '/ru/login?mode=link');
});

test('форма входа по ссылке отвечает одинаково для неизвестного адреса', async ({ page }) => {
  await page.goto('/ru/login');
  await page.getByRole('button', { name: 'Войти по ссылке на email' }).click();
  await page.getByLabel('Email', { exact: true }).fill(`nobody-${uniqueSub()}@example.test`);
  await page.getByRole('button', { name: 'Получить ссылку' }).click();
  await expect(main(page).getByRole('status')).toContainText('Если адрес подтверждён');
});

test('шаг первого входа показывается один раз', async ({ page }) => {
  const claims = { sub: uniqueSub(), name: 'Нодир', company_id: '501', company_name: 'ACME Trade' };
  await signInAsCustom(page, claims, { stopAtWelcome: true });
  await expect(page).toHaveURL(/\/ru\/welcome/);
  // Адреса из Smartup нет: поле пустое, пропуск адреса не требует.
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await expect(page).toHaveURL(/\/ru$/);
  await signOutClient(page, 'Нодир');
  await signInAsCustom(page, claims, { stopAtWelcome: true });
  await expect(page).toHaveURL(/\/ru$/);
});

test('адрес можно указать позже в профиле', async ({ page }) => {
  const sub = uniqueSub();
  // Вход сразу через "Войти заново": адрес для входа меняется только после недавнего входа (решение 0083).
  await signInAsCustom(page, { sub, name: 'Тимур', company_id: '502', company_name: 'Globex' }, { startAt: '/ru/login?reauth=1' });
  await page.goto('/ru/settings');
  await page.getByLabel('Email', { exact: true }).fill(`t${sub}@globex.test`);
  await page.getByRole('button', { name: 'Отправить ссылку' }).click();
  await expect(main(page).getByRole('status')).toContainText('Мы отправили письмо');
  await mailLink(`t${sub}@globex.test`, 'confirm-email');
});

test('ссылка подтверждения без токена и испорченная ссылка входа дают понятное сообщение', async ({ page }) => {
  await page.goto('/ru/confirm-email');
  await expect(main(page).getByRole('alert')).toContainText('Ссылка уже не действует');
  await page.goto('/ru/login/link?token=broken');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(main(page).getByRole('alert')).toContainText('Ссылка уже не действует');
  await expect(page).toHaveURL(/\/ru\/login\/link\?error=link_invalid$/);
  await page.getByRole('link', { name: 'Получить новую ссылку' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
});
