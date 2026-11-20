import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub, withOwnAddress } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount, storageStateOf } from './helpers/staff';

// Организации в рабочем месте и роль участника (FR-ID-13, FR-ADM-02, ТЗ 14.3).
// Рабочее место проверяется на ноутбуке. Сотрудник l1 входит из сохранённой сессии:
// по его учётной записи тест журнала аудита считает входы.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');

/** Клиент новой компании: организация появляется при его первом входе. */
async function newClientCompany(page: Page) {
  const sub = uniqueSub();
  const company = `Компания ${sub}`;
  const name = `Клиент ${sub}`;
  await withOwnAddress(page);
  await signInAsCustom(page, { sub, name, company_id: `c${sub}`, company_name: company });
  return { company, name };
}

test('care находит организацию и назначает администратора клиента', async ({ page, browser }) => {
  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  const { company, name } = await newClientCompany(client);
  expect((await client.goto('/ru/org'))!.status()).toBe(404);

  await signInStaff(page, staffAccount('care'));
  await page.getByRole('button', { name: 'Клиенты' }).click();
  await page.getByRole('menuitem', { name: 'Организации' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/organizations$/);
  await page.getByLabel('Поиск').fill(company);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('link', { name: company }).click();

  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Пользователь');
  await row.getByRole('button', { name: 'Сделать администратором' }).click();
  await expect(main(page).getByRole('status')).toContainText('Роль изменена');
  await expect(row).toContainText('Администратор');

  // Роль действует со следующего запроса клиента.
  expect((await client.goto('/ru/org'))!.status()).toBe(200);
  await clientContext.close();
});

test('смена роли со старым входом просит войти заново и возвращает на карточку', async ({ page, browser }) => {
  const clientContext = await browser.newContext();
  const { company, name } = await newClientCompany(await clientContext.newPage());
  await clientContext.close();

  await signInStaff(page, staffAccount('care'));
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith('hub.session_token'));
  const token = decodeURIComponent(cookie!.value).split('.')[0];
  // Вход сделан 20 минут назад: для действий администратора он уже не свежий.
  await dbRows(`update auth.session set "createdAt" = now() - interval '20 minutes' where token = $1`, [token]);

  await page.goto(`/ru/agent/organizations?q=${encodeURIComponent(company)}`);
  await page.getByRole('link', { name: company }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(company);
  const card = page.url();
  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Сделать администратором' }).click();
  await expect(main(page).getByRole('alert')).toContainText('нужен свежий вход');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Пользователь');

  await main(page).getByRole('link', { name: 'Войти заново' }).click();
  await expect(page).toHaveURL(/\/ru\/staff\/login\?reauth=1&next=/);
  const care = staffAccount('care');
  await signInStaff(page, care, { startAt: page.url() });
  await expect(page).toHaveURL(card);
});

test.describe('первая линия', () => {
  test.use({ storageState: storageStateOf('l1') });

  test('видит организации и участников, но не кнопки управления', async ({ page }) => {
    await page.goto('/ru/agent/organizations?q=ACME');
    await page.getByRole('link', { name: 'ACME Trade' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ACME Trade');
    await expect(page.getByRole('row', { name: /Алишер/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сделать администратором' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Пригласить' })).toHaveCount(0);
  });

  test('пустой поиск, слишком длинный запрос и неизвестная организация', async ({ page }) => {
    await page.goto(`/ru/agent/organizations?q=${uniqueSub()}`);
    await expect(main(page)).toContainText('Организации не найдены');
    await page.goto(`/ru/agent/organizations?q=${'x'.repeat(101)}`);
    await expect(main(page).getByRole('alert')).toContainText('Запрос слишком длинный');
    expect((await page.goto('/ru/agent/organizations/01900000-0000-7000-8000-000000000000'))!.status()).toBe(404);
    expect((await page.goto('/ru/agent/organizations/not-a-uuid'))!.status()).toBe(404);
  });
});

test('клиент рабочее место организаций не открывает', async ({ page }) => {
  await newClientCompany(page);
  expect((await page.goto('/ru/agent/organizations'))!.status()).toBe(404);
});
