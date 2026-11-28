import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { intakeOf, outboxMail, postWebhook, sendLetter, unknownAddress } from './helpers/inbound';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { mailLink } from './helpers/mail';
import { storageStateOf } from './helpers/staff';

// Письма в поддержку (план M4, задача 11, сценарий 17): письмо с неизвестного адреса попадает в "Неопознанные",
// сотрудник привязывает его к организации клиента, отправитель принимает приглашение и видит обращение в кабинете.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
// Customer Care, а не первая линия: ответ сотрудника делает обращение "моим", а очередь "Мои" первой линии проверяет
// параллельный тест agent.spec.ts.
test.use({ storageState: storageStateOf('care') });

const main = (page: Page) => page.getByRole('main');

test('сценарий 17: письмо с неизвестного адреса, привязка, обращение видно клиенту после входа по приглашению', async ({ page, browser, request }) => {
  const address = unknownAddress();
  const subject = `Не приходят остатки ${Date.now()}`;
  const number = await sendLetter(request, { from: `Бобур <${address}>`, subject, text: 'После обновления не приходят остатки со склада' });

  await page.goto('/ru/agent/queues');
  await main(page).getByRole('link', { name: /^Неопознанные\s*\d+$/ }).click();
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

  const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
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

test('сценарий S10 и 16: письмо клиента создаёт обращение, ответ на письмо в нём же, агент отвечает, клиент продолжает в портале', async ({ page, browser, request }) => {
  const sub = uniqueSub();
  const address = `client-${sub}@acme-e2e.test`;
  // Свой контекст без сессии сотрудника из test.use.
  const clientContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const client = await clientContext.newPage();
  await signInAsCustom(client, { sub, name: 'Шахноза', email: address, company_id: `c${sub}`, company_name: `Компания ${sub}` });
  // Адрес из Smartup подтверждается ссылкой; в тесте он подтверждён сразу, как после перехода по ссылке.
  await dbRows(`update auth."user" set email = $1, "emailVerified" = true, "claimedEmail" = null where "claimedEmail" = $1`, [address]);

  const subject = `Не печатается накладная ${sub}`;
  const number = await sendLetter(request, { from: `Шахноза <${address}>`, subject, text: 'После обновления накладная не печатается', dmarc: true });
  const ack = await outboxMail(address, (mail) => mail.subject.includes(`[SUP-${number}]`));
  expect(ack.text).toContain(`/ru/tickets/SUP-${number}`);
  expect(ack.replyTo).toMatch(/^reply\+/);

  // Ответ на письмо попадает в то же обращение.
  const replied = await sendLetter(request, { from: address, to: [ack.replyTo as string], subject: `Re: ${ack.subject}`, text: 'Ответ из почты: принтер HP, драйвер обновлён', dmarc: true });
  expect(replied).toBe(number);

  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(main(page)).toContainText('Ответ из почты: принтер HP, драйвер обновлён');
  const composer = main(page).getByRole('form', { name: 'Ответ по обращению' });
  await expect(composer).toHaveAttribute('data-ready', '');
  await composer.getByRole('radio', { name: 'Ответ клиенту' }).check();
  await composer.getByLabel('Текст ответа').fill('Проверьте права пользователя склада на печать');
  await composer.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(main(page).locator('article:not([data-internal])').last()).toContainText('Проверьте права пользователя склада');
  const reply = await outboxMail(address, (mail) => mail.text.includes('Проверьте права пользователя склада'));
  expect(reply.subject).toContain(`[SUP-${number}]`);

  await client.goto(`/ru/tickets/SUP-${number}`);
  await expect(client.getByRole('main')).toContainText('Проверьте права пользователя склада на печать');
  await expect(client.getByRole('main')).toContainText('Ответ из почты: принтер HP');
  await client.getByLabel('Ответ').fill('Права выдали, накладная печатается');
  await client.getByRole('button', { name: 'Отправить' }).click();
  await expect(client.getByRole('main')).toContainText('Права выдали, накладная печатается');
  await clientContext.close();
});

test('вебхук с неверной подписью отклоняется, автоответ сохраняется без обращения', async ({ request }) => {
  const bad = await postWebhook(request, { from: unknownAddress(), subject: 'Подделка', text: 'Текст' }, { badSignature: true });
  expect(bad.status).toBe(401);
  expect(await dbRows(`select 1 from hdn_email_inbound where provider_id = $1`, [bad.emailId])).toEqual([]);
  const auto = await postWebhook(request, { from: unknownAddress(), subject: 'Автоответ: в отпуске', text: 'Я в отпуске до понедельника', headers: [['Auto-Submitted', 'auto-replied']] });
  expect(auto.status).toBe(200);
  expect(await intakeOf(auto.emailId)).toEqual({ classification: 'auto', number: null });
});
