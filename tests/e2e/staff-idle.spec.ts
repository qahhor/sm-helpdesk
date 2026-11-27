import { type Browser, expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Срок бездействия сотрудника 30 минут (план M9, задача 4, решение 8; ASVS V7.3.1): после простоя страница ведёт на
// вход с возвратом на ту же страницу, черновик ответа после повторного входа на месте. Время на сервере не
// подменить, поэтому простой задаётся в базе: последнее действие сессии 31 минуту назад.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

async function clientTicket(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

test('31 минута без действий: вход с возвратом на обращение, черновик на месте', async ({ browser }) => {
  const number = await clientTicket(browser, `Срок бездействия ${Date.now()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const account = staffAccount('l1');
  await signInStaff(page, account);
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  const composer = page.getByRole('main').getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByLabel('Текст ответа').fill('Черновик до перерыва на обед');
  await expect(composer.getByText('Черновик сохранён')).toBeVisible();

  // Простой: последнее действие этой сессии 31 минуту назад (сессии из файлов .auth не трогаются).
  const cookies = await context.cookies();
  const token = decodeURIComponent(cookies.find((c) => c.name.endsWith('session_token'))?.value ?? '').split('.')[0];
  await dbRows(`update auth.session set "staffActiveAt" = now() - interval '31 minutes', "secondFactorAt" = now() - interval '40 minutes' where token = $1`, [token]);

  await page.reload();
  await expect(page).toHaveURL(/\/ru\/staff\/login\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('next') ?? '')).toBe(`/ru/agent/tickets/SUP-${number}`);
  expect(await dbRows(`select 1 from auth.session where token = $1`, [token])).toEqual([]);

  await signInStaff(page, account, { startAt: page.url() });
  await expect(page).toHaveURL(new RegExp(`/ru/agent/tickets/SUP-${number}$`));
  await expect(page.getByRole('main').getByLabel('Текст ответа')).toHaveValue('Черновик до перерыва на обед');
  await context.close();
});
