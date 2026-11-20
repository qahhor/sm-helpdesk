import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { lastBotMessage, sendTelegramUpdate, uniqueTelegramId } from './helpers/telegram';

// Привязка Telegram и запасной вход из бота (сценарий 21 раздела 15.3; ложный Telegram на порту 3192).

const main = (page: Page) => page.getByRole('main');

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'кабинет клиента проверяется на телефоне и ноутбуке');
});

/** Код привязки, который получил бы бот: кнопка ведёт на обработчик портала, он перенаправляет в t.me. */
async function linkCode(page: Page): Promise<string> {
  const href = await page.getByRole('link', { name: 'Привязать Telegram' }).getAttribute('href');
  const response = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const target = new URL(response.headers().location ?? '');
  expect(target.origin).toBe('https://t.me');
  return target.searchParams.get('start') ?? '';
}

test('клиент привязывает Telegram в настройках и входит по ссылке из бота', async ({ page, browser }) => {
  const telegramId = uniqueTelegramId();
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Без почты', company_id: '501', company_name: 'ACME Trade' });
  await page.goto('/ru/settings');
  await sendTelegramUpdate({ from: telegramId, text: `/start ${await linkCode(page)}` });
  expect((await lastBotMessage(telegramId)).text).toContain('ACME Trade');
  await page.reload();
  await expect(main(page)).toContainText(`Привязан аккаунт @e2e${telegramId}`);

  await sendTelegramUpdate({ from: telegramId, text: '/login' });
  const link = (await lastBotMessage(telegramId)).linkButton?.url ?? '';
  expect(link).toMatch(/^http:\/\/localhost:3100\/ru\/login\/tg\?token=/);
  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  // Telegram сам открывает ссылку для предпросмотра: ссылка от этого не сгорает.
  expect((await fresh.request.get(link)).status()).toBe(200);
  await fresh.goto(link);
  await fresh.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(fresh).toHaveURL(/\/ru$/);
  await expect(fresh.getByRole('banner')).toContainText('ACME Trade');
  await fresh.goto(link);
  await fresh.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(main(fresh).getByRole('alert')).toContainText('Ссылка уже не действует');
  await freshContext.close();
});

test('отвязка в настройках убирает привязку, бот это подтверждает', async ({ page }) => {
  const telegramId = uniqueTelegramId();
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Отвязка', company_id: '501', company_name: 'ACME Trade' });
  await page.goto('/ru/settings');
  await sendTelegramUpdate({ from: telegramId, text: `/start ${await linkCode(page)}` });
  await page.reload();
  await page.getByRole('button', { name: 'Отвязать' }).click();
  await expect(main(page).getByRole('status')).toContainText('Telegram отвязан');
  await expect(page.getByRole('link', { name: 'Привязать Telegram' })).toBeVisible();
  expect((await lastBotMessage(telegramId)).text).toContain('отвязан');
});

test('страница входа показывает путь через бота', async ({ page }) => {
  await page.goto('/ru/login');
  await expect(page.getByRole('link', { name: /бота/ })).toHaveAttribute('href', 'https://t.me/smartup_hub_dev_bot');
});

test('страница входа из бота и раздел Telegram на 360 px без прокрутки и без нарушений доступности', async ({ page }) => {
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Доступность', company_id: '501', company_name: 'ACME Trade' });
  await page.setViewportSize({ width: 360, height: 740 });
  for (const locale of ['ru', 'uz', 'en'])
    for (const path of ['/settings', '/login/tg?token=broken']) {
      await page.goto(`/${locale}${path}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${locale}${path}`).toBe(true);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${locale}${path} ${v.id}`)).toEqual([]);
    }
});
