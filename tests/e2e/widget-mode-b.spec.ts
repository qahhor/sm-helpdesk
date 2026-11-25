import { expect, test } from '@playwright/test';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';

// Режим B виджета (план M6, задача 8; FR-WG-04, решения 11 и 12): загрузчик без токена контекста открывает
// /{язык}/tickets/new#widget=1&hints=... в новой вкладке. Здесь адрес открывается сразу, без страницы хозяина:
// путь от загрузчика проверяет tests/e2e/widget-host.spec.ts. Подсказки идут только во фрагменте и в sessionStorage
// вкладки: ни один запрос к порталу не несёт их в адресе, после входа форма подставляет ошибку и модуль.

const MODULE_CODE = 'widget_mode_b';

test.beforeAll(async () => {
  await dbRows(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Склад (режим B)", "uz": "Ombor (B rejimi)", "en": "Warehouse (mode B)"}') on conflict (code) do nothing`, [
    MODULE_CODE,
  ]);
});

test('подсказки режима B переживают вход, не уходят на сервер в адресе, обращение учитывается как виджет', async ({ page }, info) => {
  test.skip(info.project.name === 'narrow', 'ширина ноутбука проверяется проектом desktop');
  const marker = `WB${Date.now().toString(36)}`;
  const hints = { module: MODULE_CODE, form: 'stock_move', appVersion: '5.12.0', errorCode: 'ORA-20777', errorText: `Склад ${marker} закрыт для перемещения` };
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));

  // Без входа: портал ведёт на вход, фрагмент переносится в хранилище вкладки и убирается из адреса.
  await page.goto(`/ru/tickets/new#widget=1&hints=${encodeURIComponent(JSON.stringify(hints))}`);
  await expect(page).toHaveURL(/\/ru\/login\?next=/);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Режим Бэ', company_id: '501', company_name: 'ACME Trade' }, { startAt: page.url() });
  if (!new URL(page.url()).pathname.endsWith('/tickets/new')) await page.goto('/ru/tickets/new');

  await expect(page.getByTestId('from-widget')).toBeVisible();
  await expect(page.getByLabel('Что случилось?')).toHaveValue(`ORA-20777: ${hints.errorText}`);
  await expect(page.locator('select[name="moduleId"] option:checked')).toHaveText('Склад (режим B)');
  await page.getByLabel('Что случилось?').fill(`ORA-20777: ${hints.errorText}\nПеремещал товар между складами`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);

  // Ни один адрес запроса не несёт подсказок: ни текста ошибки, ни признака виджета (пункт 9 раздела "На что смотреть").
  expect(urls.filter((url) => url.includes(marker) || url.includes('hints') || url.includes('ORA-20777'))).toEqual([]);
  const [row] = await dbRows<{ source: string; context: Record<string, string>; module: string | null }>(
    `select t.source, t.context, m.code as module from hdt_tickets t left join hdr_product_modules m on m.module_id = t.module_id where t.number = $1`,
    [number],
  );
  expect(row).toEqual({
    source: 'widget_web',
    module: MODULE_CODE,
    context: { moduleCode: MODULE_CODE, screen: 'stock_move', version: '5.12.0', errorCode: 'ORA-20777', errorText: hints.errorText },
  });
});

test('без признака виджета форма обычная: источник портал', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'одна проверка');
  await signInAsCustom(page, { sub: uniqueSub(), name: 'Портал Обычный', company_id: '501', company_name: 'ACME Trade' }, { startAt: '/ru/login?next=/ru/tickets/new' });
  if (!new URL(page.url()).pathname.endsWith('/tickets/new')) await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]')).toBeVisible();
  await expect(page.getByTestId('from-widget')).toHaveCount(0);
  await page.getByLabel('Что случилось?').fill('Не печатается накладная на складе');
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const [row] = await dbRows<{ source: string }>(`select source from hdt_tickets where number = $1`, [Number(/SUP-(\d+)/.exec(page.url())?.[1])]);
  expect(row?.source).toBe('portal');
});
