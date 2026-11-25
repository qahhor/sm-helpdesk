import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Frame, type Page, test } from '@playwright/test';
import { ticketErrorSignature } from '@/modules/hdk/signature';
import { signInAsCustom, uniqueSub } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';
import { blockThirdPartyCookies, contextTokenUrl, FOREIGN, HUB, openHost, useMockContextKeys, widgetFrame, widgetPersona } from './helpers/widget';

// Виджет на демонстрационной странице Smartup Web (план M6, задача 9; ТЗ 15.3, сценарий 6; строка M6 раздела 16.2).
// Страница хозяина scripts/mock-smartup-host.mjs работает на другом сайте (127.0.0.1:3195), iframe портала на ней
// сторонний, куки третьей стороны закрыты (Chromium настройкой через CDP, WebKit сам). Сценарий S1 в режимах A и B,
// повтор токена контекста, посторонний сайт, подменённые сообщения, продление токена, доступность и три ширины.
// Проект webkit (только CI, решение 0060) запускает этот файл в движке Safari.

test.beforeEach(blockThirdPartyCookies);

/** Ошибка, которую вызывает кнопка "Вызвать ошибку" демонстрационной страницы. */
const DEMO_ERROR = { errorCode: 'ORA-20001', errorText: 'Недостаточно остатка на складе "Основной" для товара "Мука"' };
const DEMO_TEXT = `${DEMO_ERROR.errorCode}: ${DEMO_ERROR.errorText}`;
const MODULE_CODE = 'e2e-widget-host';
const SOLUTION_TITLE = 'Не хватает остатка на складе при сохранении заказа (виджет)';

let key: string;
test.beforeAll(async () => {
  key = await useMockContextKeys();
});

const only = (projects: string[]) => (_: unknown, info: { project: { name: string } }) => test.skip(!projects.includes(info.project.name), `проекты: ${projects.join(', ')}`);

/**
 * Опубликованное решение, привязанное к сигнатуре ошибки демонстрационной страницы (точное совпадение, ТЗ 11.5).
 * Решение публикует вторая линия через редактор один раз на базу; сигнатура привязывается строкой, как это делает
 * редактор решения.
 */
async function knownErrorSolution(browser: Browser): Promise<void> {
  const signature = ticketErrorSignature({ context: DEMO_ERROR, description: '' })?.signature;
  if (!signature) throw new Error('у ошибки демонстрационной страницы нет сигнатуры');
  let [article] = await dbRows<{ article_id: string }>(`select article_id from hdk_published where title = $1 and audience = 'clients' limit 1`, [SOLUTION_TITLE]);
  if (!article) {
    await dbRows(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Склад (виджет)", "uz": "Ombor (vidjet)", "en": "Warehouse (widget)"}') on conflict (code) do nothing`, [MODULE_CODE]);
    const context = await browser.newContext({ storageState: storageStateOf('l2') });
    const page = await context.newPage();
    await page.goto('/ru/agent/solutions/new');
    await page.getByLabel('Заголовок').fill(SOLUTION_TITLE);
    await page.getByLabel('Модуль').selectOption({ label: 'Склад (виджет)' });
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
    const number = Number(/solutions\/(\d+)/.exec(page.url())?.[1]);
    const editor = page.locator('.doc-editor');
    await editor.locator(':scope > p').first().click();
    await page.keyboard.type('При сохранении заказа Smartup пишет, что на складе не хватает остатка товара.');
    await editor.locator('.node-step p').first().click();
    await page.keyboard.type('Откройте Склад, затем Остатки, и проверьте остаток товара на складе заказа');
    await expect(page.getByTestId('save-status')).toHaveText(/Сохранено в/, { timeout: 15_000 });
    await page.getByTestId('solution-review').getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
    await context.close();
    [article] = await dbRows<{ article_id: string }>(`select article_id from hdk_articles where number = $1`, [number]);
  }
  await dbRows(
    `insert into hdk_error_signatures (signature, article_id, sample_code, sample_message) values ($1, $2, $3, $4)
     on conflict on constraint hdk_error_signatures_u1 do update set article_id = excluded.article_id`,
    [signature, article?.article_id, DEMO_ERROR.errorCode, DEMO_ERROR.errorText],
  );
}

/** Открывает панель меню "Помощь" страницы хозяина, как пользователь Smartup Web. */
async function helpMenu(page: Page, item: 'Сообщить о проблеме' | 'Мои обращения'): Promise<void> {
  await page.getByRole('button', { name: 'Помощь' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Запросы обмена токена контекста страницей виджета. */
function exchanges(page: Page): { url: string; status: number }[] {
  const seen: { url: string; status: number }[] = [];
  page.on('response', (response) => {
    if (response.url() === `${HUB}/api/embed/session`) seen.push({ url: response.url(), status: response.status() });
  });
  return seen;
}

/** Ставит куку от имени страницы виджета и читает её: со сторонним iframe и закрытыми куками третьей стороны её нет. */
const thirdPartyCookieStored = (frame: Frame) =>
  frame.evaluate(() => {
    document.cookie = 'hub_probe=1; SameSite=None; Secure; Path=/';
    return document.cookie.includes('hub_probe=1');
  });

test('S1 режим A: ошибка в Smartup, "Мы знаем эту ошибку" по сигнатуре, обращение с контекстом без входа и кук', async ({ page, context, browser }, info) => {
  only(['desktop', 'phone', 'webkit'])(undefined, info);
  test.setTimeout(90_000);
  await knownErrorSolution(browser);
  await openHost(page, { key, persona: widgetPersona(), hints: { module: MODULE_CODE, form: 'order_edit', appVersion: '5.12.0' } });
  await page.getByRole('button', { name: 'Вызвать ошибку' }).click();
  await helpMenu(page, 'Сообщить о проблеме');

  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByTestId('widget-error')).toContainText(DEMO_TEXT);
  await expect(frame.getByText('Ошибка в модуле Склад (виджет)')).toBeVisible();
  const suggestions = frame.getByTestId('widget-suggestions');
  await expect(suggestions.getByRole('heading', { name: 'Мы знаем эту ошибку' })).toBeVisible({ timeout: 10_000 });
  await expect(suggestions.getByText(SOLUTION_TITLE).first()).toBeVisible();
  // Решение открывается в панели; "Не помогло" ведёт к форме.
  await suggestions.getByRole('button', { name: 'Открыть решение' }).first().click();
  await expect(frame.getByTestId('widget-solution')).toContainText('Откройте Склад, затем Остатки');
  await frame.getByRole('button', { name: 'Назад к форме' }).click();
  await frame.getByRole('button', { name: 'Не помогло, отправить обращение' }).click();

  await frame.getByLabel('Что вы делали перед ошибкой?').fill('Сохранял заказ на муку со склада "Основной"');
  await frame.getByRole('button', { name: 'Отправить обращение', exact: true }).click();
  await expect(frame.getByTestId('widget-created')).toContainText(/Обращение SUP-\d+ создано/);
  const number = Number(/SUP-(\d+)/.exec((await frame.getByTestId('widget-created').textContent()) ?? '')?.[1]);
  await expect.poll(() => page.evaluate(() => (window as Window & { __created?: number[] }).__created)).toEqual([number]);

  const [row] = await dbRows<{ source: string; context: Record<string, string>; module: string | null; signature: string | null }>(
    `select t.source, t.context, m.code as module, t.error_signature as signature
       from hdt_tickets t left join hdr_product_modules m on m.module_id = t.module_id where t.number = $1`,
    [number],
  );
  expect(row).toEqual({
    source: 'widget_web',
    module: MODULE_CODE,
    signature: ticketErrorSignature({ context: DEMO_ERROR, description: '' })?.signature,
    context: { moduleCode: MODULE_CODE, screen: 'order_edit', version: '5.12.0', ...DEMO_ERROR, platform: 'web' },
  });
  // Ни одной куки портала, а куки третьей стороны в этом браузере закрыты: виджету они и не нужны (решение 1).
  expect((await context.cookies(HUB)).map((c) => c.name)).toEqual([]);
  if (info.project.name === 'webkit') info.annotations.push({ type: 'third-party-cookies', description: (await thirdPartyCookieStored(frame)) ? 'разрешены' : 'закрыты' });
  else expect(await thirdPartyCookieStored(frame)).toBe(false);
});

test('S1 режим B: без getContextToken меню "Помощь" открывает портал в новой вкладке, после входа форма с ошибкой', async ({ page }, info) => {
  only(['desktop', 'webkit'])(undefined, info);
  await openHost(page, { key, persona: widgetPersona(), mode: 'b', hints: { module: MODULE_CODE } });
  await page.getByRole('button', { name: 'Вызвать ошибку' }).click();
  const popupPromise = page.waitForEvent('popup');
  await helpMenu(page, 'Сообщить о проблеме');
  const popup = await popupPromise;
  // Панели на странице хозяина нет: режим B не встраивает портал.
  expect(page.frames().some((frame) => frame.url().includes('/embed/'))).toBe(false);
  const urls: string[] = [];
  popup.on('request', (request) => urls.push(request.url()));
  await expect(popup).toHaveURL(/\/ru\/login\?next=/);
  await expect.poll(() => popup.evaluate(() => window.location.hash)).toBe('');

  await signInAsCustom(popup, { sub: uniqueSub(), name: 'Режим Бэ', company_id: '501', company_name: 'ACME Trade' }, { startAt: popup.url() });
  if (!new URL(popup.url()).pathname.endsWith('/tickets/new')) await popup.goto('/ru/tickets/new');
  await expect(popup.getByTestId('from-widget')).toBeVisible();
  await expect(popup.getByLabel('Что случилось?')).toHaveValue(DEMO_TEXT);
  await popup.getByLabel('Что случилось?').fill(`${DEMO_TEXT}\nСохранял заказ, режим B`);
  // Подсказка может свернуть поля: "Не помогло" их раскрывает.
  const notHelped = popup.getByRole('button', { name: /Не помогло/ });
  if (await notHelped.isVisible().catch(() => false)) await notHelped.click();
  await popup.getByRole('button', { name: 'Отправить обращение', exact: true }).click();
  await expect(popup).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(popup.url())?.[1]);
  expect(urls.filter((url) => url.includes('hints') || url.includes('ORA-20001') || url.includes('widget=1'))).toEqual([]);
  const [row] = await dbRows<{ source: string; context: Record<string, string> }>(`select source, context from hdt_tickets where number = $1`, [number]);
  expect(row).toEqual({ source: 'widget_web', context: { moduleCode: MODULE_CODE, ...DEMO_ERROR } });
});

test('режим B и при ошибке getContextToken: портал по кнопке "Открыть портал" в новой вкладке с подсказками во фрагменте', async ({ page }, info) => {
  only(['desktop'])(undefined, info);
  // Shadow DOM загрузчика закрыт, локаторы Playwright в него не заходят: только в этом тесте он открывается, чтобы
  // нажать кнопку настоящим нажатием (окно портала браузер открывает только из нажатия, замечание I2 проверки M6).
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
  await openHost(page, { key, persona: widgetPersona(), mode: 'fail' });
  await page.getByRole('button', { name: 'Вызвать ошибку' }).click();
  let popups = 0;
  page.on('popup', () => popups++);
  await helpMenu(page, 'Сообщить о проблеме');
  const openPortal = page.getByRole('button', { name: 'Открыть портал' });
  await expect(openPortal).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __tokens?: number }).__tokens)).toBe(1);
  // Без нажатия окно не открывается.
  expect(popups).toBe(0);
  const popupPromise = page.waitForEvent('popup');
  await openPortal.click();
  const popup = await popupPromise;
  await expect(openPortal).toBeHidden();
  await expect(popup).toHaveURL(/\/ru\/login\?next=/);
  // Фрагмент перенесён в хранилище вкладки и убран из адреса.
  await expect.poll(() => popup.evaluate(() => window.location.hash)).toBe('');
  const saved = await popup.evaluate(() => window.sessionStorage.getItem('hub.widget-handoff'));
  expect(JSON.parse(saved ?? '{}').hints).toEqual(DEMO_ERROR);
});

test('повторно предъявленный токен контекста отклоняется', async ({ request }, info) => {
  only(['desktop'])(undefined, info);
  const issued = await request.post(contextTokenUrl(widgetPersona()));
  const { token } = (await issued.json()) as { token: string };
  const exchange = () => request.post('/api/embed/session', { headers: { origin: HUB }, data: { contextToken: token } });
  expect((await exchange()).status()).toBe(200);
  const replay = await exchange();
  expect(replay.status()).toBe(401);
  // Один ответ без причины (решение 4 плана): причина только в журнале работы.
  expect(await replay.json()).toMatchObject({ code: 'invalid_context' });
});

test('посторонний сайт с тем же ключом не встраивает портал: страница виджета не запускается', async ({ page }, info) => {
  only(['desktop', 'webkit'])(undefined, info);
  const headers: string[] = [];
  page.on('response', (response) => {
    if (response.url().startsWith(`${HUB}/ru/embed/`)) headers.push(response.headers()['content-security-policy'] ?? '');
  });
  await openHost(page, { key, persona: widgetPersona(), origin: FOREIGN });
  await helpMenu(page, 'Сообщить о проблеме');
  await expect.poll(() => headers.length).toBeGreaterThan(0);
  // Ответ портала разрешает встраивание только адресам сервера, постороннего адреса в нём нет.
  expect(headers.join('\n')).toContain('frame-ancestors http://localhost:3190 http://127.0.0.1:3195');
  expect(headers.join('\n')).not.toContain(FOREIGN);
  // Браузер страницу не показал: она не прислала ready, поэтому хозяин ни разу не просил токен контекста.
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as Window & { __tokens?: number }).__tokens)).toBe(0);
  for (const frame of page.frames().filter((f) => f.url().startsWith(HUB))) expect(await frame.getByRole('heading').count()).toBe(0);
});

test('подменённые сообщения игнорируются: хозяин не верит своему окну, страница виджета не верит себе', async ({ page }, info) => {
  only(['desktop', 'webkit'])(undefined, info);
  const seen = exchanges(page);
  await openHost(page, { key, persona: widgetPersona() });
  await helpMenu(page, 'Сообщить о проблеме');
  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await expect.poll(() => seen.length).toBe(1);

  // Сообщение от имени портала, но из окна хозяина: загрузчик его отбрасывает, обработчик хозяина не вызван.
  await page.evaluate(() => window.postMessage({ hub: 1, type: 'ticket-created', number: 999 }, '*'));
  // Сообщение хозяина, но из самой страницы виджета (не window.parent): страница его отбрасывает и токен не меняет.
  await frame.evaluate(() => window.postMessage({ hub: 1, type: 'token', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' }, '*'));
  await frame.evaluate(() => window.postMessage({ hub: 1, type: 'init', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', hints: {}, theme: 'dark', locale: 'uz' }, '*'));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as Window & { __created?: number[] }).__created)).toEqual([]);
  expect(seen).toHaveLength(1);
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  expect(await frame.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
});

test('продление: за минуту до конца токена виджета страница просит у хозяина новый токен контекста', async ({ page }, info) => {
  only(['desktop'])(undefined, info);
  await page.clock.install();
  const seen = exchanges(page);
  await openHost(page, { key, persona: widgetPersona() });
  await helpMenu(page, 'Сообщить о проблеме');
  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await expect.poll(() => seen.length).toBe(1);
  expect(await page.evaluate(() => (window as Window & { __tokens?: number }).__tokens)).toBe(1);

  // Токен виджета живёт 15 минут, продление за минуту до конца.
  await page.clock.fastForward('14:05');
  await expect.poll(() => page.evaluate(() => (window as Window & { __tokens?: number }).__tokens)).toBe(2);
  await expect.poll(() => seen.map((s) => s.status)).toEqual([200, 200]);
  // С новым токеном панель работает: "Мои обращения" читает список.
  await frame.getByRole('button', { name: 'Мои обращения' }).click();
  await expect(frame.getByRole('heading', { name: 'Мои обращения' })).toBeVisible();
});

test('токен виджета истёк во сне: запрос с ответом 401 ждёт новый токен и повторяется один раз (проверка M6, M5)', async ({ page }, info) => {
  only(['desktop'])(undefined, info);
  const seen = exchanges(page);
  await openHost(page, { key, persona: widgetPersona() });
  await helpMenu(page, 'Сообщить о проблеме');
  const frame = await widgetFrame(page, '/ru/embed/report');
  await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
  await expect.poll(() => seen.length).toBe(1);
  // Компьютер спал дольше 15 минут: таймер продления не сработал, сервер отвечает 401 на просроченный токен виджета.
  // Часы сервера тест не двигает, поэтому первый ответ 401 подставляется.
  let rejected = 0;
  await page.route('**/api/embed/tickets', async (route) => {
    if (route.request().method() !== 'POST' || rejected > 0) return route.continue();
    rejected += 1;
    return route.fulfill({ status: 401, contentType: 'application/problem+json', headers: { 'WWW-Authenticate': 'Bearer' }, body: JSON.stringify({ status: 401, code: 'unauthenticated' }) });
  });
  await frame.getByLabel('Что вы делали перед ошибкой?').fill('Открыл заказ после сна компьютера, нажал "Сохранить"');
  await frame.getByRole('button', { name: 'Отправить обращение', exact: true }).click();
  await expect(frame.getByTestId('widget-created')).toContainText(/Обращение SUP-\d+ создано/);
  expect(rejected).toBe(1);
  expect(await page.evaluate(() => (window as Window & { __tokens?: number }).__tokens)).toBe(2);
  expect(seen.map((s) => s.status)).toEqual([200, 200]);
});

// --- Доступность и ширины (раздел 16.2: axe без серьёзных замечаний, 360, 768 и 1280 px) ---

const AXE_SOURCE = readFileSync(createRequire(createRequire(resolve('package.json')).resolve('@axe-core/playwright')).resolve('axe-core/axe.min.js'), 'utf8');

/**
 * axe внутри страницы виджета. iframe лежит в закрытом Shadow DOM загрузчика, и AxeBuilder страницы хозяина до него
 * не доходит: сценарий axe выполняется прямо во фрейме (evaluate не подчиняется CSP страницы).
 */
async function frameViolations(frame: Frame): Promise<string[]> {
  await frame.evaluate(AXE_SOURCE);
  const result = await frame.evaluate(() => (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact?: string }[] }> } }).axe.run());
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
}

for (const width of [360, 768, 1280]) {
  test(`панель виджета и /m/report на ${width} px: без серьёзных замечаний axe и без прокрутки вбок`, async ({ page, request }, info) => {
    only(['desktop'])(undefined, info);
    await page.setViewportSize({ width, height: 800 });
    await openHost(page, { key, persona: widgetPersona() });
    await page.getByRole('button', { name: 'Вызвать ошибку' }).click();
    await helpMenu(page, 'Сообщить о проблеме');
    const frame = await widgetFrame(page, '/ru/embed/report');
    await expect(frame.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
    await expect(frame.getByTestId('widget-error')).toBeVisible();
    // Панель 400 px справа, уже 600 px на весь экран (ТЗ 11.9).
    const frameWidth = await frame.evaluate(() => window.innerWidth);
    if (width <= 600) expect(frameWidth).toBe(width);
    else expect(frameWidth).toBeLessThanOrEqual(400);
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await frameViolations(frame)).toEqual([]);

    // Страница для мобильного приложения на той же ширине.
    const issued = await request.post(contextTokenUrl(widgetPersona(), 'android'));
    const { token } = (await issued.json()) as { token: string };
    await page.goto(`/ru/m/report#ctx=${token}`);
    await expect(page.getByRole('heading', { name: 'Сообщить об ошибке' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
}
