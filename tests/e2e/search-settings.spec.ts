import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signInStaff, staffAccount } from './helpers/staff';

// Раздел "Поиск" настроек (план W6, задача 9; ответ владельца 0070, пункт 4): администратор ведёт синонимы, словарь
// узбекского и закрепление решений; неверная строка называется номером. Блок "Что клиенты ищут и не находят" на
// странице показателей видит администратор (решение 17). Браузерные тесты идут при SEARCH_PROVIDER=postgres: наборы
// хранятся и уходят в Typesense задачей, когда он включён.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'настройки проверяются на ноутбуке');
});
// Настройки меняет только свежий вход администратора (не старше 15 минут): тест входит сам, без сохранённой сессии.
test.use({ storageState: { cookies: [], origins: [] } });

const main = (page: Page) => page.getByRole('main');

test('администратор сохраняет синонимы, словарь и закрепление; неверная строка называется', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings');
  await main(page).getByRole('link', { name: /Поиск/ }).first().click();
  await expect(page).toHaveURL(/\/ru\/agent\/settings\/search/);

  await main(page).getByLabel('Наборы синонимов').fill('склад, ombor, warehouse\nнакладная => yuk xati, invoice');
  await main(page).getByRole('button', { name: 'Сохранить синонимы' }).click();
  await expect(main(page).getByText('Синонимы сохранены.')).toBeVisible();
  await expect(main(page).getByLabel('Наборы синонимов')).toHaveValue('склад, ombor, warehouse\nнакладная => yuk xati, invoice');

  await main(page).getByLabel('Пары слово = основа').fill("to'lovlar = to'lov");
  await main(page).getByRole('button', { name: 'Сохранить словарь' }).click();
  await expect(main(page).getByText('Словарь сохранён.')).toBeVisible();

  await main(page).getByLabel('Правила закрепления').fill('накладная | 1042 | 99');
  await main(page).getByRole('button', { name: 'Сохранить правила' }).click();
  await expect(main(page).getByText('Раздел "Закрепление решений", строка 1')).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

test('страница показателей: блок запросов подсказки без результата у администратора', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/metrics');
  const block = main(page).locator('[data-block="suggest-misses"]');
  await expect(block.getByRole('heading', { name: 'Что клиенты ищут и не находят' })).toBeVisible();
});
