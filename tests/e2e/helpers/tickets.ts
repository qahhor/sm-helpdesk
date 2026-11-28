import { type Browser, expect } from '@playwright/test';
import { CLIENT_STATE } from './client';
import { dbRows } from './db';

// Своё обращение для теста: клиент создаёт его через форму портала. Тесты не опираются на "последнее обращение
// в базе": рядом идут другие проекты и файлы (проверка качества, Q8).

/** Обращение общего клиента тестов. Возвращает номер без префикса SUP-. */
export async function createClientTicket(browser: Browser, text = 'Не проводится накладная на складе Основной'): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`${text} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}
