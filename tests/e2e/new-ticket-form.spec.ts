import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';

// Форма нового обращения после неудачной отправки (проверка интерфейса, U3-U5; UX-C-10): фокус встаёт на поле с
// ошибкой и оно видно на экране, ошибка снимается при вводе, выбранные значения остаются выбранными.

test.use({ storageState: CLIENT_STATE });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'кабинет клиента проверяется на телефоне и ноутбуке');
});

async function openForm(page: import('@playwright/test').Page) {
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  // Черновик прежнего теста не должен заполнять описание.
  await page.getByLabel('Что случилось?').fill('');
}

test('пустая отправка: фокус на описании, поле видно, ошибка снимается при вводе', async ({ page }) => {
  await openForm(page);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  const description = page.getByLabel('Что случилось?');
  await expect(description).toHaveAttribute('aria-invalid', 'true');
  await expect(description).toBeFocused();
  await expect(description).toBeInViewport();
  await description.pressSequentially('Не проводится накладная');
  await expect(description).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#field-description-error')).toHaveCount(0);
});

test('после неудачной отправки влияние, тип и видимость остаются выбранными', async ({ page }) => {
  await openForm(page);
  const impact = page.getByLabel('Влияние на работу');
  await impact.selectOption({ label: 'Неудобство' });
  // "Тип" меняется на значение не по умолчанию: сброс формы вернул бы первое (второй проход, F13).
  await page.getByRole('radio', { name: 'Вопрос' }).check();
  await page.getByRole('radio', { name: 'Только я' }).check();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByLabel('Что случилось?')).toHaveAttribute('aria-invalid', 'true');
  // Раньше сброс формы после действия сервера показывал первое значение списка: "Работа остановлена".
  await expect(impact).toHaveValue('minor');
  await expect(impact.locator('option:checked')).toHaveText('Неудобство');
  await expect(page.getByRole('radio', { name: 'Вопрос' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Только я' })).toBeChecked();
});
