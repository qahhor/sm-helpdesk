import { expect, type Page } from '@playwright/test';

// Вход клиента в браузерных тестах через ложный сервер Smartup (scripts/mock-oidc.mjs).

export type Persona = 'alisher' | 'dilnoza' | 'timur' | 'nocompany';
export type CustomClaims = { sub: string; name: string; email?: string; company_id?: string; company_name?: string; role?: string };

/** Вход персоной ложного сервера по умолчанию. */
export async function signInAs(page: Page, persona: Persona, opts: { startAt?: string } = {}): Promise<void> {
  await page.goto(opts.startAt ?? '/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  await page.getByRole('link', { name: persona, exact: true }).click();
  await expect(page).not.toHaveURL(/localhost:319\d/);
}

/** Вход своей персоной: сведения задаются полями формы ложного сервера. */
export async function signInAsCustom(page: Page, claims: CustomClaims): Promise<void> {
  await page.goto('/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  for (const [field, value] of Object.entries(claims)) if (value) await page.locator(`input[name="claim_${field}"]`).fill(value);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/localhost:319\d/);
}
