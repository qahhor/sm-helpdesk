import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { totp } from '../../helpers/totp';
import { dbRows } from './db';

// Сотрудники браузерных тестов. Их один раз заводит проект setup (tests/e2e/staff.setup.ts):
// приглашение, пароль и второй фактор проходят через интерфейс, как у настоящего сотрудника.
// Учётные данные и сохранённые сессии лежат в tests/e2e/.auth (каталог не попадает в репозиторий).

export const AUTH_DIR = 'tests/e2e/.auth';
const STAFF_FILE = `${AUTH_DIR}/staff.json`;

export type StaffKey = 'care' | 'l1' | 'admin';
export type E2eStaff = { key: StaffKey; name: string; role: string; email: string; password: string; totpSecret: string };

/** Сохранённая сессия сотрудника: для тестов, которым нужен уже вошедший сотрудник. */
export const storageStateOf = (key: StaffKey) => `${AUTH_DIR}/${key}.json`;
export const staffFile = STAFF_FILE;

export function staffAccount(key: StaffKey): E2eStaff {
  const all = JSON.parse(readFileSync(STAFF_FILE, 'utf8')) as Record<StaffKey, E2eStaff>;
  return all[key];
}

/**
 * Приглашение сотрудника строкой в базе: токен случайный, в базе лежит его хеш, как у настоящего приглашения.
 * Возвращает токен для ссылки /ru/staff/setup?token=...
 */
export async function createStaffInvitation(input: { email: string; name: string; role: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await dbRows(
    `insert into hdu_invitations (email, role, name, token_hash, expires_on) values ($1, $2, $3, $4, now() + interval '24 hours')`,
    [input.email, input.role, input.name, createHash('sha256').update(token).digest('hex')],
  );
  return token;
}

/** Вход сотрудника через страницу входа: пароль, затем код из приложения. */
export async function signInStaff(page: Page, staff: E2eStaff, opts: { startAt?: string } = {}): Promise<void> {
  await page.goto(opts.startAt ?? '/ru/staff/login');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Пароль', { exact: true }).fill(staff.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByLabel('Код из приложения').fill(totp(staff.totpSecret));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page).not.toHaveURL(/\/staff\/login/);
}

/** Задание пароля по ссылке приглашения и подключение второго фактора. Возвращает ключ для приложения с кодами. */
export async function acceptAndEnroll(page: Page, input: { token: string; email: string; password: string }): Promise<string> {
  await page.goto(`/ru/staff/setup?token=${input.token}`);
  await page.getByLabel('Пароль', { exact: true }).fill(input.password);
  await page.getByLabel('Пароль ещё раз').fill(input.password);
  await page.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login\?setup=1$/);
  await page.getByLabel('Email').fill(input.email);
  await page.getByLabel('Пароль', { exact: true }).fill(input.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
  await page.getByLabel('Код из приложения').fill(totp(secret));
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page).toHaveURL(/\/ru\/agent$/);
  return secret;
}
