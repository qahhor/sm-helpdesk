import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { signInStaff, staffAccount } from './helpers/staff';

// Экран "Уведомления и почта" (план M4, задача 12, решение 23): администратор задаёт адреса поддержки, показываемый
// адрес клиенты видят в подвале кабинета.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'настройки проверяются на ноутбуке');
});
// Настройки меняет только свежий вход администратора (не старше 15 минут): тест входит сам, без сохранённой сессии.
test.use({ storageState: { cookies: [], origins: [] } });

const main = (page: Page) => page.getByRole('main');

test('администратор добавляет два адреса поддержки, показываемый виден в подвале портала', async ({ page, browser }) => {
  const first = `support-${Date.now()}@greenwhite.test`;
  const second = `help-${Date.now()}@smartup24.test`;
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings');
  await main(page).getByRole('link', { name: /Уведомления и почта/ }).first().click();
  await expect(page).toHaveURL(/\/ru\/agent\/settings\/mail/);

  // Прежние адреса других запусков убираются, первый новый становится показываемым сам.
  for (const box of await main(page).getByRole('checkbox', { name: 'Убрать' }).all()) await box.check();
  await main(page).getByLabel('Новый адрес поддержки').fill(first);
  await main(page).getByRole('button', { name: 'Сохранить адреса' }).click();
  await expect(main(page).getByRole('status')).toContainText('Адреса поддержки сохранены.');
  await main(page).getByLabel('Новый адрес поддержки').fill(second);
  await main(page).getByRole('button', { name: 'Сохранить адреса' }).click();
  await main(page).getByRole('radio', { name: second }).check();
  await main(page).getByRole('button', { name: 'Сохранить адреса' }).click();
  await expect(main(page).locator(`li[data-address="${second}"]`)).toContainText('Показывать клиентам');
  await expect(main(page).locator(`li[data-address="${first}"]`)).toContainText('Приём не проверялся');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const portal = await client.newPage();
  await portal.goto('/ru');
  const footer = portal.getByRole('contentinfo');
  await expect(footer).toContainText(`Поддержка: ${second}`);
  await expect(footer.getByRole('link', { name: second })).toHaveAttribute('href', `mailto:${second}`);
  await client.close();
});

test('срок "взять в работу" после передачи: администратор задаёт минуты, пустое поле возвращает срок первого ответа (FR-LINE-06)', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/sla');
  const field = main(page).getByLabel('P1, минут');
  await field.fill('15');
  await main(page).getByRole('region', { name: 'Взять в работу после передачи' }).getByRole('button', { name: 'Сохранить' }).click();
  await expect(main(page).getByText('Срок "взять в работу" сохранён')).toBeVisible();
  await expect(main(page).getByLabel('P1, минут')).toHaveValue('15');
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  // Возврат к сроку первого ответа: поле пустое.
  await main(page).getByLabel('P1, минут').fill('');
  await main(page).getByRole('region', { name: 'Взять в работу после передачи' }).getByRole('button', { name: 'Сохранить' }).click();
  await expect(main(page).getByLabel('P1, минут')).toHaveValue('');
});
