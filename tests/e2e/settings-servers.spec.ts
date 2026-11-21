import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { dropSession, signInStaff, staffAccount } from './helpers/staff';

// Раздел "Настройки" рабочего места и реестр серверов Smartup (FR-ADM-01, раздел 8.11 ТЗ).
// Сервер проверки: третий ложный сервер входа на порту 3193 (scripts/mock-oidc.mjs), в реестр он не записан.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');
const sections = (page: Page) => page.getByRole('navigation', { name: 'Разделы настроек' });

test('администратор добавляет сервер Smartup, секрет на страницу не возвращается', async ({ page }) => {
  await dbRows(`delete from hdu_server_checks where server_id in (select server_id from hdu_servers where code = 'e2e-server')`);
  await dbRows(`delete from hdu_servers where code = 'e2e-server'`);
  await signInStaff(page, staffAccount('admin'));
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('menuitem', { name: 'Все настройки' }).click();
  await sections(page).getByRole('link', { name: 'Серверы Smartup' }).click();
  await page.getByRole('link', { name: 'Добавить сервер' }).click();
  await page.getByLabel('Код').fill('e2e-server');
  await page.getByLabel('Название').fill('Проверочный');
  await page.getByLabel('Адрес Smartup').fill('http://localhost:3193');
  await page.getByLabel('Адрес сервера входа').fill('http://localhost:3193');
  await page.getByLabel('Идентификатор клиента').fill('hub');
  await page.getByLabel('Секрет клиента').fill('e2e-secret-value');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  // После добавления открывается карточка: на ней адрес возврата и проверка связи.
  await expect(main(page).getByRole('status')).toContainText('Сервер добавлен');
  await sections(page).getByRole('link', { name: 'Серверы Smartup' }).click();
  await expect(page.getByRole('row', { name: /e2e-server/ })).toContainText('Не проверялся');

  await page.getByRole('link', { name: 'e2e-server' }).click();
  expect(await page.content()).not.toContain('e2e-secret-value');
  await expect(main(page)).toContainText('/api/auth/sso/callback/e2e-server');
  await page.getByRole('button', { name: 'Проверить связь' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сервер отвечает');

  // Изменение без нового секрета: секрет остаётся прежним, пометка "задан" на месте.
  await page.getByLabel('Название').fill('Проверочный 2');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сервер сохранён');
  await expect(main(page)).toContainText('Секрет задан');

  // Отключение закрывает вход клиентам сервера: сначала подтверждение.
  await page.getByRole('link', { name: 'Отключить' }).click();
  await expect(main(page)).toContainText('Отключить сервер Проверочный 2?');
  await page.getByRole('button', { name: 'Да, отключить' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сервер отключён');
  await page.getByRole('button', { name: 'Включить' }).click();
  await expect(main(page).getByRole('status')).toContainText('Сервер включён');
  await sections(page).getByRole('link', { name: 'Серверы Smartup' }).click();
  await expect(page.getByRole('row', { name: /e2e-server/ })).toContainText('Сервер отвечает');
});

test('care и первая линия раздел настроек не видят и не открывают', async ({ page }) => {
  for (const key of ['care', 'l1'] as const) {
    await dropSession(page);
    await signInStaff(page, staffAccount(key));
    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByRole('menuitem', { name: 'Все настройки' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    for (const path of ['/ru/agent/settings', '/ru/agent/settings/servers', '/ru/agent/settings/servers/mock'])
      expect((await page.goto(path))!.status(), `${key} ${path}`).toBe(404);
  }
});

test('ниже 1024 px разделы настроек в выпадающем списке, страницы без прокрутки вбок и без нарушений доступности', async ({ page }) => {
  // Шесть страниц на трёх языках и двух ширинах: проверка доступности каждой занимает время.
  test.setTimeout(120_000);
  await signInStaff(page, staffAccount('admin'));
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto('/ru/agent/settings/servers');
  await page.getByText('Раздел: Серверы Smartup').click();
  await expect(sections(page).getByRole('link', { name: 'Серверы Smartup' })).toBeVisible();
  for (const width of [1280, 800])
    for (const locale of ['ru', 'uz', 'en'])
      for (const path of ['/agent/settings', '/agent/settings/servers', '/agent/settings/servers/new', '/agent/settings/servers/mock', '/agent/settings/staff', '/agent/settings/staff?invite=1', '/agent/settings/audit']) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/${locale}${path}`);
        const label = `${width} ${locale}${path}`;
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${label} ${v.id}`)).toEqual([]);
      }
});
