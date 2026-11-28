import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE, signInAsCustom, uniqueSub, withOwnAddress } from './helpers/client';
import { mailLink } from './helpers/mail';

// Приглашения и страница организации (FR-ID-08, FR-ID-13, пункт 12 таблицы решений M1).
// У каждого теста своя компания: администратор приходит из Smartup с ролью director (соответствие ролей сервера).

const main = (page: Page) => page.getByRole('main');

function company() {
  const sub = uniqueSub();
  return { sub, companyId: `c${sub}`, name: `Компания ${sub}` };
}

async function signInAsDirector(page: Page, org: ReturnType<typeof company>): Promise<void> {
  await signInAsCustom(page, { sub: org.sub, name: 'Директор', company_id: org.companyId, company_name: org.name, role: 'director' });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'кабинет клиента проверяется на телефоне и ноутбуке');
  await withOwnAddress(page);
});

test('администратор приглашает коллегу, коллега принимает и попадает в кабинет', async ({ page, browser }) => {
  const org = company();
  await signInAsDirector(page, org);
  await page.getByRole('banner').getByRole('button', { name: 'Директор' }).click();
  await page.getByRole('menuitem', { name: 'Организация' }).click();
  await expect(page).toHaveURL(/\/ru\/org$/);

  const email = `colleague-${org.sub}@acme.test`;
  await page.getByLabel('Email коллеги').fill(email);
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect(main(page).getByRole('status')).toContainText('Приглашение отправляется на почту');
  await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Ждёт ответа');

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const link = await mailLink(email, 'invitation');
  // Почтовый сканер открыл ссылку первым: приглашение от этого не принимается.
  expect((await guestContext.request.get(link)).status()).toBe(200);
  await guest.goto(link);
  await expect(guest.getByRole('heading', { level: 1 })).toContainText(org.name);
  await guest.getByLabel('Ваше имя').fill('Коллега');
  await guest.getByRole('button', { name: 'Принять приглашение' }).click();
  await expect(guest).toHaveURL(/\/ru$/);
  await expect(guest.getByRole('banner')).toContainText(org.name);
  // Повторно ссылка не срабатывает.
  await guest.goto(link);
  await expect(guest.getByRole('main').getByRole('alert')).toContainText('Приглашение уже не действует');
  await guestContext.close();

  await page.reload();
  await expect(page.getByRole('row', { name: /Коллега/ })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Принято');
});

test('администратор отключает участника, тот теряет доступ на следующем запросе', async ({ page, browser }) => {
  const org = company();
  const colleagueContext = await browser.newContext();
  const colleague = await colleagueContext.newPage();
  const name = `Уволенный ${org.sub}`;
  await signInAsCustom(colleague, { sub: `${org.sub}m`, name, company_id: org.companyId, company_name: org.name });
  await signInAsDirector(page, org);
  await page.goto('/ru/org');

  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'Отключить' }).click();
  await page.getByRole('button', { name: 'Отключить участника' }).click();
  await expect(row).toContainText('Отключён');
  await colleague.goto('/ru/tickets');
  await expect(colleague).toHaveURL(/\/ru\/no-organization$/);
  // Себя отключить нельзя.
  await expect(page.getByRole('row', { name: /Это вы/ }).getByRole('button', { name: 'Отключить' })).toHaveCount(0);

  await row.getByRole('button', { name: 'Включить' }).click();
  await expect(row).toContainText('Активен');
  await colleague.goto('/ru/tickets');
  await expect(colleague).toHaveURL(/\/ru\/tickets$/);
  await colleagueContext.close();
});

test('администратор отзывает приглашение, ссылка больше не действует', async ({ page, browser }) => {
  const org = company();
  await signInAsDirector(page, org);
  await page.goto('/ru/org');
  // Сводка по обращениям организации для администратора клиента (ТЗ 5.1; волна 7, T8).
  const summary = page.getByTestId('org-summary');
  await expect(summary.getByRole('heading', { name: 'Обращения организации' })).toBeVisible();
  await expect(summary).toContainText(/Всего: \d+\. Открыто: \d+\./);
  await expect(summary.locator('[data-status]')).toHaveCount(6);
  const email = `revoked-${org.sub}@acme.test`;
  await page.getByLabel('Email коллеги').fill(email);
  await page.getByRole('button', { name: 'Пригласить' }).click();
  const row = page.getByRole('row', { name: new RegExp(email) });
  await row.getByRole('button', { name: 'Отозвать' }).click();
  await expect(row).toContainText('Отозвано');
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(await mailLink(email, 'invitation'));
  await expect(guest.getByRole('main').getByRole('alert')).toContainText('Приглашение уже не действует');
});

test('обычный пользователь страницу организации и пункт меню не видит', async ({ browser }) => {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  expect((await page.goto('/ru/org'))!.status()).toBe(404);
  await page.goto('/ru');
  await page.getByRole('banner').getByRole('button', { name: 'Алишер' }).click();
  await expect(page.getByRole('menuitem', { name: 'Настройки' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Организация' })).toHaveCount(0);
  await context.close();
});

test('страница организации на 360 px без горизонтальной прокрутки и без нарушений доступности', async ({ page }) => {
  const org = company();
  await signInAsDirector(page, org);
  await page.setViewportSize({ width: 360, height: 740 });
  // Ждущее приглашение: таблица приглашений тоже на странице.
  await page.goto('/ru/org');
  await page.getByLabel('Email коллеги').fill(`long-address-for-layout-${org.sub}@a-very-long-company-domain.example`);
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect(main(page).getByRole('status')).toBeVisible();
  for (const locale of ['ru', 'uz', 'en']) {
    await page.goto(`/${locale}/org`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), locale).toBe(true);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${locale} ${v.id}`)).toEqual([]);
  }
});

test('испорченная ссылка приглашения даёт понятное сообщение', async ({ page }) => {
  await page.goto('/ru/invite?token=broken');
  await expect(main(page).getByRole('alert')).toContainText('Приглашение уже не действует');
});
