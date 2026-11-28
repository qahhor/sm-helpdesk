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

/** Ждёт возврата на портал после страницы ложного сервера и проходит шаг первого входа, если не просили остановиться на нём. */
async function finishSignIn(page: Page, opts: SignInOptions): Promise<void> {
  await expect(page).not.toHaveURL(/localhost:319\d|\/api\/auth\//);
  if (!opts.stopAtWelcome && new URL(page.url()).pathname.endsWith('/welcome')) {
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await expect(page).not.toHaveURL(/\/welcome/);
  }
}

/** deviceLocale: false: не выбирать язык на устройстве перед входом (тест языка профиля, FR-I18N-06). */
export type SignInOptions = { startAt?: string; stopAtWelcome?: boolean; deviceLocale?: false };

/**
 * Язык, выбранный на этом устройстве: кука hub_locale с языком страницы входа. После входа портал открывает страницы
 * на языке пользователя: сначала выбор на устройстве, затем язык профиля (волна 7, T5; решение 0160). Общий клиент
 * тестов меняет язык профиля в других тестах, поэтому вход в тестах закрепляет язык страницы входа явно.
 */
async function chooseDeviceLocale(page: Page, startAt: string): Promise<void> {
  const locale = /^\/(ru|uz|en)(?:\/|$)/.exec(startAt)?.[1];
  const origin = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
  if (locale) await page.context().addCookies([{ name: 'hub_locale', value: locale, url: origin }]);
}

/** Вход персоной ложного сервера по умолчанию. */
export async function signInAs(page: Page, persona: Persona, opts: SignInOptions = {}): Promise<void> {
  await withOwnAddress(page);
  if (opts.deviceLocale !== false) await chooseDeviceLocale(page, opts.startAt ?? '/ru/login');
  await page.goto(opts.startAt ?? '/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  await page.getByRole('link', { name: persona, exact: true }).click();
  await finishSignIn(page, opts);
}

/** Вход своей персоной: сведения задаются полями формы ложного сервера. */
export async function signInAsCustom(page: Page, claims: CustomClaims, opts: SignInOptions = {}): Promise<void> {
  await withOwnAddress(page);
  if (opts.deviceLocale !== false) await chooseDeviceLocale(page, opts.startAt ?? '/ru/login');
  await page.goto(opts.startAt ?? '/ru/login');
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  for (const [field, value] of Object.entries(claims)) if (value) await page.locator(`input[name="claim_${field}"]`).fill(value);
  await page.getByRole('button', { name: 'Войти' }).click();
  await finishSignIn(page, opts);
}

/**
 * "Войти заново" после отказа из-за давнего входа (решение 0083): кнопка завершает сессию, страница входа с reauth=1
 * начинает вход через Smartup с prompt=login, ложный сервер снова спрашивает сведения. Возврат на исходную страницу.
 */
export async function signInAgain(page: Page, claims: CustomClaims): Promise<void> {
  await page.getByRole('button', { name: 'Войти заново' }).click();
  await expect(page).toHaveURL(/\/ru\/login\?reauth=1/);
  await expect(page.getByText('Войдите заново, чтобы продолжить.')).toBeVisible();
  await page.getByRole('link', { name: /Войти через Smartup/ }).click();
  for (const [field, value] of Object.entries(claims)) if (value) await page.locator(`input[name="claim_${field}"]`).fill(value);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/localhost:319\d|\/api\/auth\/|\/login/);
}

/** Идентификатор пользователя Smartup, которого ещё не было: у каждого теста и прогона свой. */
export function uniqueSub(): string {
  return `9${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Выход клиента через меню пользователя в шапке. */
export async function signOutClient(page: Page, name: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/ru\/login/);
}
