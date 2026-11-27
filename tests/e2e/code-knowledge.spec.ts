import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { uniqueReport } from '../helpers/code-scan';
import { callOk, e2eMcpClient, seedAgentForE2e } from './helpers/agent';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Раздел "Знания из кода" (веха M8c, задача 4; 8.12; FR-CODE-03, 13, FR-ADM-15): AI-сотрудник передаёт отчёт о
// сканировании через сервер MCP, вторая линия видит новые записи выделенными, открывает карточку (место в коде
// ссылкой, кода нет), утверждает одну и отклоняет другую; история сканирований и карта модулей. Первая линия раздела
// не видит. Три ширины без горизонтальной прокрутки и проверка доступности.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.use({ storageState: { cookies: [], origins: [] } });

const main = (page: Page) => page.getByRole('main');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('очередь утверждения: новые записи выделены, карточка без кода, утверждение и отклонение, история и карта модулей', async ({ page }) => {
  test.setTimeout(240_000);
  const agent = await seedAgentForE2e(['code_catalog_upsert']);
  const report = uniqueReport();
  expect(await callOk(e2eMcpClient(agent.value), 'code_catalog_upsert', report)).toMatchObject({ status: 'accepted', added: 3 });
  const [orders, stock] = [report.errors[0]!.key, report.errors[1]!.key];

  await signInStaff(page, staffAccount('l2'));
  await page.goto('/ru/agent');
  const nav = page.getByRole('navigation', { name: 'Разделы' });
  await nav.getByRole('button', { name: 'Знания' }).click();
  await page.getByRole('menuitem', { name: 'Знания из кода' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/code-knowledge$/);
  const row = main(page).locator(`tr[data-code-entry="${orders}"]`);
  await expect(row).toContainText('ORA-20001');
  await expect(row).toContainText('Черновик');
  await expect(row).toContainText('Новое');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);

  await row.getByRole('link', { name: orders }).click();
  const card = main(page).locator('[data-code-card]');
  await expect(card).toContainText('Недостаточно остатка товара {product} на складе {warehouse}');
  await expect(card).toContainText('ORDER_PKG.SAVE_ORDER, db/packages/order_pkg.pkb, строка 412');
  await expect(card).toContainText('Остаток по товару на складе заказа');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `карточка, ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);
  await main(page).getByRole('button', { name: 'Утвердить' }).click();
  await expect(main(page).getByText('Запись утверждена.', { exact: false })).toBeVisible();
  await expect(card).toContainText('Утверждено');
  expect(await dbRows(`select status from hda_code_error_entries where key = $1`, [orders])).toEqual([{ status: 'approved' }]);

  await page.goto(`/ru/agent/code-knowledge/${encodeURIComponent(stock)}`);
  await main(page).getByLabel('Причина отклонения, если нужна').fill('Не та причина');
  await main(page).getByRole('button', { name: 'Отклонить' }).click();
  await expect(main(page).getByText('Запись отклонена.')).toBeVisible();
  expect(await dbRows(`select status, reject_reason from hda_code_error_entries where key = $1`, [stock])).toEqual([{ status: 'rejected', reject_reason: 'Не та причина' }]);

  await main(page).getByRole('link', { name: 'Знания из кода' }).click();
  await main(page).getByRole('link', { name: 'История сканирований' }).click();
  await expect(main(page).locator(`tr[data-code-scan="${report.scanId}"]`)).toContainText('Принят: новых 3, изменено 0, исчезло 0');
  expect(await seriousAxe(page)).toEqual([]);
  await main(page).getByRole('link', { name: 'Карта модулей' }).click();
  await expect(main(page).locator(`tr[data-code-module="${report.modules[0]!.code}"]`)).toContainText('Нового модуля нет в справочнике');
  // Применяет к справочнику только администратор: у второй линии кнопки нет.
  await expect(main(page).getByRole('button', { name: 'Применить к справочнику' })).toHaveCount(0);
  expect(await seriousAxe(page)).toEqual([]);
});

test('первая линия раздела "Знания из кода" не видит ни в меню, ни по адресу', async ({ page }) => {
  test.setTimeout(120_000);
  await signInStaff(page, staffAccount('l1'));
  await page.goto('/ru/agent');
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('button', { name: 'Знания' }).click();
  await expect(page.getByRole('menuitem', { name: 'Знания из кода' })).toHaveCount(0);
  const response = await page.goto('/ru/agent/code-knowledge');
  expect(response?.status()).not.toBe(200);
});
