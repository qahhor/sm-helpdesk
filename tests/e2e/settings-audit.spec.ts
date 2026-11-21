import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub, withOwnAddress } from './helpers/client';
import { signInStaff, staffAccount } from './helpers/staff';

// Журнал аудита в разделе "Настройки" (FR-ADM-07) и настройки организации на её карточке (FR-ADM-02).

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');

/** Новая компания клиента: организация появляется при первом входе. */
async function newCompany(page: Page): Promise<string> {
  const sub = uniqueSub();
  const company = `Аудит ${sub}`;
  await withOwnAddress(page);
  await signInAsCustom(page, { sub, name: `Клиент ${sub}`, company_id: `a${sub}`, company_name: company });
  return company;
}

test('care меняет категорию и отключает AI-обработку, администратор видит это в журнале текстом', async ({ page, browser }) => {
  const clientContext = await browser.newContext();
  const company = await newCompany(await clientContext.newPage());
  await clientContext.close();

  await signInStaff(page, staffAccount('care'));
  await page.goto('/ru/agent/organizations');
  await page.getByLabel('Поиск').fill(company);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('link', { name: company }).click();
  await page.getByLabel('Категория клиента').selectOption('B');
  await page.getByLabel('Обращения обрабатывает AI-помощник').uncheck();
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сохранено');
  await expect(page.getByLabel('Обращения обрабатывает AI-помощник')).not.toBeChecked();

  await page.context().clearCookies();
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings');
  await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Журнал аудита' }).click();
  await page.getByLabel('Действие').selectOption('org.updated');
  await page.getByRole('button', { name: 'Показать' }).click();
  const row = page.getByRole('row', { name: new RegExp(company) }).first();
  // Поле словами интерфейса, а не кодом (проверка main, Q14).
  await expect(row).toContainText('Категория клиента');
  await expect(row).toContainText('B');
  await expect(row).toContainText(staffAccount('care').name);
  await expect(main(page).getByRole('button', { name: /Удалить|Изменить/ })).toHaveCount(0);
});

test('журнал открывает только администратор', async ({ page }) => {
  await signInStaff(page, staffAccount('care'));
  expect((await page.goto('/ru/agent/settings/audit'))!.status()).toBe(404);
});
