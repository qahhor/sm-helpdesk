import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub, withOwnAddress } from './helpers/client';
import { dropSession, signInStaff, staffAccount } from './helpers/staff';

// Согласие на AI-обработку (план M9, задача 2, решение 10). Организация, созданная первым входом через Smartup,
// работает без AI; Customer Care включает обработку только с датой и основанием согласия, выключение отметку
// сохраняет, администратор видит оба действия в журнале аудита.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');

test('новая организация без AI; care отмечает согласие, выключает, администратор видит журнал', async ({ page, browser }) => {
  const sub = uniqueSub();
  const company = `Согласие ${sub}`;
  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  await withOwnAddress(client);
  await signInAsCustom(client, { sub, name: `Клиент ${sub}`, company_id: `c${sub}`, company_name: company });
  await clientContext.close();

  await signInStaff(page, staffAccount('care'));
  await page.goto('/ru/agent/organizations');
  await page.getByLabel('Поиск').fill(company);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('link', { name: company }).click();
  await expect(page.getByTestId('org-ai-consent')).toHaveText('Отметки согласия нет.');

  // Без даты и основания форма не уходит: поля обязательные.
  await page.getByRole('button', { name: 'Включить AI-обработку' }).click();
  await expect(page.getByLabel('Дата согласия')).toHaveJSProperty('validity.valueMissing', true);
  await page.getByLabel('Дата согласия').fill('2026-11-20');
  await page.getByLabel('Основание').fill('Письмо 14/2026');
  await page.getByRole('button', { name: 'Включить AI-обработку' }).click();
  await expect(main(page).getByRole('status')).toContainText('AI-обработка включена, согласие отмечено.');
  await expect(page.getByTestId('org-ai-consent')).toContainText('Письмо 14/2026');

  await page.getByRole('button', { name: 'Выключить AI-обработку' }).click();
  await expect(main(page).getByRole('status')).toContainText('AI-обработка выключена.');
  await expect(page.getByTestId('org-ai-consent')).toContainText('Письмо 14/2026');

  await dropSession(page);
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/audit');
  await page.getByLabel('Действие').selectOption('org.ai_consent_recorded');
  await page.getByRole('button', { name: 'Показать' }).click();
  const row = page.getByRole('row', { name: new RegExp(company) }).first();
  await expect(row).toContainText('Основание согласия');
  await expect(row).toContainText('Письмо 14/2026');
  await page.getByLabel('Действие').selectOption('org.ai_disabled');
  await page.getByRole('button', { name: 'Показать' }).click();
  await expect(page.getByRole('row', { name: new RegExp(company) }).first()).toContainText(staffAccount('care').name);
});
