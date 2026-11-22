import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { sendLetter, unknownAddress } from './helpers/inbound';
import { mailLink } from './helpers/mail';
import { storageStateOf } from './helpers/staff';

// Письма в поддержку (план M4, задача 11, сценарий 17): письмо с неизвестного адреса попадает в "Неопознанные",
// сотрудник привязывает его к организации клиента, отправитель принимает приглашение и видит обращение в кабинете.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.use({ storageState: storageStateOf('l1') });

const main = (page: Page) => page.getByRole('main');

test('сценарий 17: письмо с неизвестного адреса, привязка, обращение видно клиенту после входа по приглашению', async ({ page, browser, request }) => {
  const address = unknownAddress();
  const subject = `Не приходят остатки ${Date.now()}`;
  const number = await sendLetter(request, { from: `Бобур <${address}>`, subject, text: 'После обновления не приходят остатки со склада' });

  await page.goto('/ru/agent/queues');
  await main(page).getByRole('link', { name: /^Неопознанные \(\d+\)$/ }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/queues\/unidentified/);
  await main(page).locator(`li[data-number="${number}"]`).getByRole('link').click();
  await expect(main(page)).toContainText(`От кого: ${address}`);
  await expect(main(page)).toContainText('Имя из письма: Бобур');
  await expect(main(page)).toContainText('До привязки отправитель получил только номер обращения.');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

  await main(page).getByLabel('Организация: название или ИНН').fill('ACME Trade');
  await main(page).getByRole('button', { name: 'Найти' }).click();
  await main(page).getByRole('list', { name: 'Найденные организации' }).getByRole('button', { name: 'Привязать и пригласить' }).first().click();
  await expect(main(page).getByRole('status')).toContainText('Письмо привязано, отправителю ушло приглашение.');
  await expect(main(page).locator(`li[data-number="${number}"]`)).toHaveCount(0);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(await mailLink(address, 'invitation'));
  await expect(guest.getByRole('heading', { level: 1 })).toContainText('ACME Trade');
  await guest.getByLabel('Ваше имя').fill('Бобур');
  await guest.getByRole('button', { name: 'Принять приглашение' }).click();
  await expect(guest).toHaveURL(/\/ru$/);
  await guest.goto(`/ru/tickets/SUP-${number}`);
  await expect(guest.getByRole('heading', { level: 1 })).toContainText(subject);
  await expect(guest.getByRole('main')).toContainText('После обновления не приходят остатки со склада');
  await guestContext.close();
});
