import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { totp } from '../../helpers/totp';
import { dbRows } from './db';

// Сотрудники браузерных тестов. Их один раз заводит проект setup (tests/e2e/staff.setup.ts):
// приглашение создаёт команда hub, пароль и второй фактор проходят через интерфейс, как у настоящего сотрудника.
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
 * Приглашение сотрудника командой консоли hub (собранный файл dist/hub.mjs), как на настоящем сервере.
 * Возвращает токен из напечатанной ссылки /ru/staff/setup?token=...
 */
export function createStaffInvitation(input: { email: string; name: string; role: string }): string {
  const out = execFileSync(
    process.execPath,
    ['dist/hub.mjs', 'staff:create', '--email', input.email, '--name', input.name, '--role', input.role],
    { encoding: 'utf8', env: process.env },
  );
  const token = /token=([\w-]{43})/.exec(out)?.[1];
  if (!token) throw new Error('Команда hub не напечатала ссылку приглашения');
  return token;
}

/**
 * Текущий код второго фактора. Портал не принимает код второй раз (проверка main, S11), а тесты входят
 * одним сотрудником много раз за 30 секунд. Поэтому отметки принятых кодов в базе тестов снимаются.
 */
export async function staffCode(staff: E2eStaff): Promise<string> {
  await dbRows(`delete from hdc_rate_limits where code like 'staff-totp-used:%'`);
  return totp(staff.totpSecret);
}

/**
 * Сессия этой вкладки без кнопки выхода. Сначала страница уходит на about:blank: запросы прежней страницы
 * отменяются. Иначе ответ на запрос, ушедший до очистки, ставил куку сессии обратно (портал продлевает её
 * на каждом запросе страницы), и следующий вход попадал в прежнего сотрудника.
 */
export async function dropSession(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.context().clearCookies();
}

/** Вход сотрудника через страницу входа: пароль, затем код из приложения. */
export async function signInStaff(page: Page, staff: E2eStaff, opts: { startAt?: string } = {}): Promise<void> {
  // Параллельный тест мог войти тем же сотрудником тем же кодом между снятием отметки и отправкой: вход заново.
  for (let attempt = 1; ; attempt++) {
    await page.goto(opts.startAt ?? '/ru/staff/login');
    // Прошлая попытка на самом деле прошла, только переход занял дольше ожидания: вошедшего сотрудника
    // страница входа уже не показывает. Это успех, а не повод ждать поле Email до конца теста.
    if (attempt > 1 && !/\/staff\/login/.test(new URL(page.url()).pathname)) return;
    await page.getByLabel('Email').fill(staff.email);
    await page.getByLabel('Пароль', { exact: true }).fill(staff.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByLabel('Код из приложения').fill(await staffCode(staff));
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    if (attempt === 3) break;
    try {
      await expect(page).not.toHaveURL(/\/staff\/login/, { timeout: 10_000 });
      return;
    } catch {
      // Ещё одна попытка.
    }
  }
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
