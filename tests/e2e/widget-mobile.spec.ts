import { expect, type Request as PwRequest, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { contextTokenUrl, HUB, useMockContextKeys, widgetPersona } from './helpers/widget';

// Страница для мобильного приложения /{язык}/m/report#ctx=<токен> (план M6, задача 7; FR-WG-08, ТЗ 11.9).
// Раздел "На что смотреть", пункт 9: фрагмент с токеном убирается из адресной строки сразу, до первого запроса, и не
// попадает в журнал сервера, Referer и историю. Ширина телефона 360 px (проект phone).

test.beforeAll(async () => {
  await useMockContextKeys();
});

async function contextToken(request: import('@playwright/test').APIRequestContext, platform = 'android'): Promise<string> {
  const response = await request.post(contextTokenUrl(widgetPersona(), platform));
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { token: string }).token;
}

test('токен во фрагменте: обмен, адрес без фрагмента, обращение из приложения и мои обращения на 360 px', async ({ page, request, context }, info) => {
  test.skip(info.project.name !== 'phone', 'страница приложения проверяется на ширине телефона');
  const token = await contextToken(request);
  const seen: PwRequest[] = [];
  page.on('request', (r) => seen.push(r));
  await page.goto(`/ru/m/report#ctx=${token}`);
  await expect(page.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();

  // Фрагмента нет ни в адресной строке, ни в истории, ни в запросах и их заголовке Referer.
  expect(page.url()).toBe(`${HUB}/ru/m/report`);
  expect(await page.evaluate(() => location.hash)).toBe('');
  for (const r of seen) {
    expect(r.url(), r.url()).not.toContain(token);
    expect(r.headers().referer ?? '', r.url()).not.toContain(token);
  }
  const exchange = seen.find((r) => r.url().endsWith('/api/embed/session'));
  expect(exchange).toBeDefined();
  expect(exchange?.headers().referer ?? '').toBe('');
  // Запись истории заменена: шаг вперёд после шага назад ведёт на адрес без токена.
  await page.goBack().catch(() => undefined);
  await page.goForward().catch(() => undefined);
  expect(page.url()).toBe(`${HUB}/ru/m/report`);
  await page.goto(`/ru/m/report#ctx=${await contextToken(request)}`);
  await expect(page.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();

  // Вёрстка телефона: без горизонтальной прокрутки на 360 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByLabel('Что вы делали перед ошибкой?').fill('В приложении не открывается заказ');
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page.getByTestId('widget-created')).toContainText(/Обращение SUP-\d+ создано/);
  const number = Number(/SUP-(\d+)/.exec((await page.getByTestId('widget-created').textContent()) ?? '')?.[1]);
  const [row] = await dbRows<{ source: string; context: Record<string, string> }>(`select source, context from hdt_tickets where number = $1`, [number]);
  expect(row).toEqual({ source: 'widget_mobile', context: { platform: 'android' } });

  // Переход к "Мои обращения" без перезагрузки: токен в памяти страницы.
  await page.getByRole('button', { name: 'Открыть мои обращения' }).click();
  await expect(page.getByTestId('widget-ticket')).toContainText('В приложении не открывается заказ');
  await page.getByRole('button', { name: 'Мои обращения' }).click();
  await expect(page.getByTestId('widget-tickets')).toContainText(`SUP-${number}`);
  expect(page.url()).toBe(`${HUB}/ru/m/report`);
  expect((await context.cookies(HUB)).map((c) => c.name)).toEqual([]);
  // Страница отвечает без Referer и не встраивается ни в какой фрейм.
  const response = await request.get('/ru/m/report');
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});

test('без токена и после перезагрузки страница просит открыть её заново из приложения', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'phone', 'страница приложения проверяется на ширине телефона');
  await page.goto('/ru/m/report');
  await expect(page.getByText('Откройте эту страницу заново из приложения Smartup.')).toBeVisible();
  await page.goto(`/ru/m/report#ctx=${await contextToken(request, 'ios')}`);
  await expect(page.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Откройте эту страницу заново из приложения Smartup.')).toBeVisible();
  // Повтор того же токена контекста отклоняется: одноразовый jti.
  const token = await contextToken(request, 'ios');
  await page.goto(`/ru/m/report#ctx=${token}`);
  await expect(page.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await page.goto('/ru/login');
  await page.goto(`/ru/m/report#ctx=${token}`);
  await expect(page.getByText('Откройте эту страницу заново из приложения Smartup.')).toBeVisible();
});
