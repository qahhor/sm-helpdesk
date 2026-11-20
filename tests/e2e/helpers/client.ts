import { expect, type Page } from '@playwright/test';
import { AUTH_DIR } from './staff';

// Вход клиента в браузерных тестах через ложный сервер Smartup (scripts/mock-oidc.mjs).

/**
 * Сохранённая сессия клиента (персона alisher, ACME Trade): её создаёт проект setup (tests/e2e/client.setup.ts).
 * Тестам, которые выходят из кабинета, она не подходит: выход завершил бы общую сессию. Они входят сами.
 */
export const CLIENT_STATE = `${AUTH_DIR}/client.json`;

export type Persona = 'alisher' | 'dilnoza' | 'timur' | 'nocompany';
export type CustomClaims = { sub: string; name: string; email?: string; company_id?: string; company_name?: string; role?: string };

/**
 * Свой адрес посетителя для этой страницы. Предел частоты начала входа считается по адресу
 * (30 за 10 минут, решение 0013), а все браузерные тесты идут с одной машины: без своего адреса
 * полный прогон упирается в предел. Адрес из диапазона для испытаний 198.18.0.0/15.
 */
export async function withOwnAddress(page: Page): Promise<void> {
  const part = () => Math.floor(Math.random() * 254) + 1;
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.${18 + (part() % 2)}.${part()}.${part()}` });
}

/** Вход персоной ложного сервера по умолчанию. */
export async function signInAs(page: Page, persona: Persona, opts: { startAt?: string } = {}): Promise<void> {
  await withOwnAddress(page);
  await page.goto(opts.startAt ?? '/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  await page.getByRole('link', { name: persona, exact: true }).click();
  await expect(page).not.toHaveURL(/localhost:319\d/);
}

/** Вход своей персоной: сведения задаются полями формы ложного сервера. */
export async function signInAsCustom(page: Page, claims: CustomClaims): Promise<void> {
  await withOwnAddress(page);
  await page.goto('/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  for (const [field, value] of Object.entries(claims)) if (value) await page.locator(`input[name="claim_${field}"]`).fill(value);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/localhost:319\d/);
}

/** Выход клиента через меню пользователя в шапке. */
export async function signOutClient(page: Page, name: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/ru\/login/);
}
