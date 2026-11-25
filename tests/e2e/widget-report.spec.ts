import { expect, test } from '@playwright/test';
import { BUDGET_BYTES, sumScriptBytes } from '../../scripts/checks/budget-rules.mjs';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { HUB, openHost, useMockContextKeys, WIDGET_LAUNCH, widgetFrame, widgetPersona } from './helpers/widget';

// Панель "Сообщить" в Smartup Web (план M6, задачи 4 и 5; сценарий S1, FR-WG-01..07, UX-S-09). Страница хозяина с
// загрузчиком на адресе ложного сервера mock, токен контекста ложного выпуска (ES256, ключи /context-jwks.json).
// Раздел "На что смотреть": пункт 5 (протокол в настоящем браузере), 6 (куки), 7 (текст ошибки только текстом).

test.use({ launchOptions: WIDGET_LAUNCH });

let key: string;
test.beforeAll(async () => {
  key = await useMockContextKeys();
});

test('ошибка в Smartup: уведомление, панель с ошибкой, обращение с контекстом без входа и кук', async ({ page, context, browser }, info) => {
  test.skip(info.project.name === 'narrow', 'ширина ноутбука проверяется проектом desktop');
  const xss = '<img src=x onerror="window.__xss=1">javascript:alert(1)';
  await openHost(page, { key, persona: widgetPersona(), hints: { module: 'orders', form: 'order_edit', appVersion: '5.12.0' } });
  await page.evaluate((message) => window.SmartupHub.reportError({ code: 'ORA-20001', message }), xss);
  // Уведомление само панель не открывает (FR-WG-07): фрейма ещё нет.
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('/embed/'))).toBe(false);
  await page.evaluate(() => window.SmartupHub.open({ mode: 'report' }));

  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  // Текст ошибки из подсказки только текстом (пункт 7): разметка видна как есть и не выполнилась.
  await expect(frame.getByTestId('widget-error')).toContainText(`ORA-20001: ${xss}`);
  expect(await frame.evaluate(() => (window as Window & { __xss?: number }).__xss)).toBeUndefined();
  expect(await frame.locator('[data-testid="widget-error"] img').count()).toBe(0);

  await frame.getByLabel('Что вы делали перед ошибкой?').fill('Открыл заказ и нажал "Сохранить"');
  await frame.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(frame.getByTestId('widget-created')).toContainText(/Обращение SUP-\d+ создано/);
  const number = Number(/SUP-(\d+)/.exec((await frame.getByTestId('widget-created').textContent()) ?? '')?.[1]);
  // Хозяин узнал только номер (решение 8).
  await expect.poll(() => page.evaluate(() => (window as Window & { __created?: number[] }).__created)).toEqual([number]);

  const [row] = await dbRows<{ source: string; context: Record<string, string>; org: string }>(
    `select t.source, t.context, o.name as org from hdt_tickets t join hdu_organizations o on o.org_id = t.org_id where t.number = $1`,
    [number],
  );
  expect(row).toEqual({
    source: 'widget_web',
    org: 'ACME Trade',
    context: { moduleCode: 'orders', screen: 'order_edit', version: '5.12.0', errorCode: 'ORA-20001', errorText: xss, platform: 'web' },
  });
  // Ни одной куки портала: ни у страницы виджета, ни у API (решение 1, пункт 6).
  expect((await context.cookies(HUB)).map((c) => c.name)).toEqual([]);

  // Карточка сотрудника: источник "виджет" и контекст из Smartup, текст ошибки тоже только текстом (пункт 7).
  const staff = await browser.newContext({ storageState: storageStateOf('l1') });
  const agent = await staff.newPage();
  await agent.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(agent.getByText('Источник: виджет')).toBeVisible();
  await expect(agent.locator('[data-context="errorText"]')).toHaveText(`Текст ошибки: ${xss}`);
  expect(await agent.locator('[data-context] img').count()).toBe(0);
  expect(await agent.evaluate(() => (window as Window & { __xss?: number }).__xss)).toBeUndefined();
  await staff.close();
});

test('Esc во фрейме закрывает панель, фокус возвращается на страницу хозяина', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'поведение клавиатуры одно на всех ширинах');
  await openHost(page, { key, persona: widgetPersona() });
  await page.locator('#focus-me').focus();
  await page.evaluate(() => window.SmartupHub.open({ mode: 'report' }));
  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await frame.getByLabel('Что вы делали перед ошибкой?').press('Escape');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('focus-me');
});

test('тёмная тема и язык из init (UX-S-09)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'тема одна на всех ширинах');
  await openHost(page, { key, persona: widgetPersona(), theme: 'dark', locale: 'uz' });
  await page.evaluate(() => window.SmartupHub.open());
  const frame = await widgetFrame(page, '/uz/embed/report');
  await expect(frame.getByRole('heading', { name: 'Xato haqida xabar berish' })).toBeVisible();
  expect(await frame.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
});

test('страница виджета вне фрейма никому не отвечает и не просит токен', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'одна проверка');
  await page.goto(`/ru/embed/report?key=${key}&origin=${encodeURIComponent('http://localhost:3190')}`);
  await expect(page.getByText('Эту страницу можно открыть только из Smartup.')).toBeVisible();
});

test('панель виджета на телефоне загружает не больше 170 КБ скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'бюджет считается для телефона');
  const pending: Promise<{ url: string; resourceType: string; encodedBytes: number }>[] = [];
  page.on('requestfinished', (request) => {
    // Только скрипты страницы виджета во фрейме: загрузчик и страница хозяина в бюджет портала не входят.
    if (!request.frame().url().includes('/embed/')) return;
    pending.push(request.sizes().then((sizes) => ({ url: request.url(), resourceType: request.resourceType(), encodedBytes: sizes.responseBodySize })));
  });
  await openHost(page, { key, persona: widgetPersona() });
  await page.evaluate(() => window.SmartupHub.open());
  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await frame.waitForLoadState('networkidle');
  const responses = await Promise.all(pending);
  const total = sumScriptBytes(responses);
  if (total > BUDGET_BYTES)
    for (const r of responses.filter((x) => x.resourceType === 'script').sort((a, b) => b.encodedBytes - a.encodedBytes))
      console.log(`  ${Math.round(r.encodedBytes / 1024)} КБ  ${new URL(r.url).pathname}`);
  console.log(`Скрипты панели виджета: ${Math.round(total / 1024)} КБ из ${Math.round(BUDGET_BYTES / 1024)}`);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
});

declare global {
  interface Window {
    SmartupHub: { open(opts?: { mode?: string }): void; reportError(error: { code?: string; message?: string }): void };
  }
}
