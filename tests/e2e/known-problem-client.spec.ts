import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { blockThirdPartyCookies, openHost, useMockContextKeys, widgetFrame, widgetPersona } from './helpers/widget';

// Что видит клиент об известной проблеме (ТЗ FR-KP-05, 08, 09, раздел 8.3; план M5c, задача 4): ошибка в Smartup с
// сигнатурой активной показанной проблемы даёт в панели виджета баннер вместо формы, "Меня это тоже затронуло"
// создаёт привязанное обращение; на портале баннер над формой нового обращения, в обращении блок проблемы, страница
// /problems. База браузерных тестов общая: прежние проблемы теста закрываются перед запуском.

test.beforeEach(blockThirdPartyCookies);
test.describe.configure({ mode: 'serial' });

const ERROR_CODE = 'ORA-20001';
const ERROR_TEXT = 'Накладная №1 от 01.01.2026 не проведена';
let key: string;
let problemNumber = 0;
let publicTitle = '';

const resetLimits = () => dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'problem-affected:%' or code like 'kb-suggest:%'`);
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

async function signatureOfError(browser: Browser): Promise<string> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`Не проводится.\n${ERROR_CODE}: ${ERROR_TEXT}`);
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  const [row] = await dbRows<{ error_signature: string }>(`select error_signature from hdt_tickets where number = $1`, [number]);
  return row!.error_signature;
}

test.beforeAll(async ({ browser }, info) => {
  if (info.project.name !== 'desktop') return;
  key = await useMockContextKeys();
  // Прежние проблемы этого теста закрываются: сигнатура уникальна среди активных.
  await dbRows(`update hdp_problems set status = 'closed' where internal_title like 'E2E известная %' and status <> 'closed'`);
  const signature = await signatureOfError(browser);
  await dbRows(`update hdp_problems p set status = 'closed' from hdp_problem_signatures s where s.problem_id = p.problem_id and s.signature = $1 and p.status <> 'closed'`, [signature]);
  const stamp = Date.now();
  publicTitle = `Не проводятся накладные ${stamp}`;
  const [row] = await dbRows<{ problem_id: string; number: string }>(`insert into hdp_problems (internal_title, show_to_clients, status) values ($1, true, 'fixing') returning problem_id, number`, [`E2E известная ${stamp}`]);
  problemNumber = Number(row!.number);
  await dbRows(`insert into hdp_problem_translations (problem_id, locale, public_title, public_body) values ($1, 'ru', $2, 'После обновления накладные не проводятся. Исправляем.')`, [row!.problem_id, publicTitle]);
  await dbRows(`insert into hdp_problem_signatures (problem_id, signature) values ($1, $2)`, [row!.problem_id, signature]);
});

test('виджет: баннер вместо формы, "Меня это тоже затронуло" создаёт привязанное обращение, "У меня другая проблема" открывает форму', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'одна общая проблема на прогон; ширины проверяет сам тест');
  await resetLimits();
  await openHost(page, { key, persona: widgetPersona() });
  await page.evaluate(([code, message]) => window.SmartupHub.reportError({ code, message }), [ERROR_CODE, 'Накладная №77 от 05.02.2026 не проведена']);
  await page.evaluate(() => window.SmartupHub.open({ mode: 'report' }));
  const frame = await widgetFrame(page, '/ru/embed/report');
  const banner = frame.getByTestId('widget-known-problem');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Мы знаем об этой проблеме');
  await expect(banner).toContainText(publicTitle);
  await expect(banner).toContainText('Статус: исправляем');
  // Формы нет, пока клиент не сказал, что у него другая проблема.
  await expect(frame.getByLabel('Что вы делали перед ошибкой?')).toHaveCount(0);
  await banner.getByRole('button', { name: 'У меня другая проблема' }).click();
  await expect(frame.getByLabel('Что вы делали перед ошибкой?')).toBeVisible();

  // Новое открытие панели: баннер снова, нажатие создаёт обращение.
  await openHost(page, { key, persona: widgetPersona() });
  await page.evaluate(([code, message]) => window.SmartupHub.reportError({ code, message }), [ERROR_CODE, 'Накладная №78 от 05.02.2026 не проведена']);
  await page.evaluate(() => window.SmartupHub.open({ mode: 'report' }));
  const again = await widgetFrame(page, '/ru/embed/report');
  await again.getByTestId('widget-known-problem').getByRole('button', { name: 'Меня это тоже затронуло' }).click();
  await expect(again.getByTestId('widget-created')).toContainText(/Обращение SUP-\d+ создано/);
  const number = Number(/SUP-(\d+)/.exec((await again.getByTestId('widget-created').textContent()) ?? '')?.[1]);
  const [row] = await dbRows<{ type: string; impact: string; linked: boolean }>(
    `select t.type, t.impact, t.known_problem_id = p.problem_id as linked from hdt_tickets t, hdp_problems p where t.number = $1 and p.number = $2`,
    [number, problemNumber],
  );
  expect(row).toEqual({ type: 'bug', impact: 'major', linked: true });
});

test('портал: баннер над формой, нажатие ведёт в привязанное обращение с блоком проблемы; страница проблем', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'одна общая проблема на прогон; ширины проверяет сам тест');
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await resetLimits();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`Опять не проводится.\n${ERROR_CODE}: Накладная №5 от 03.03.2026 не проведена`);
  const banner = page.getByTestId('known-problem-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(publicTitle);
  // Баннер стоит над полем описания, форма остаётся (решение 13).
  const bannerBox = await banner.boundingBox();
  const fieldBox = await page.getByLabel('Что случилось?').boundingBox();
  expect(bannerBox!.y).toBeLessThan(fieldBox!.y);
  expect(await fits(page)).toBe(true);
  expect(await seriousAxe(page)).toEqual([]);
  await resetLimits();
  await banner.getByRole('button', { name: 'Меня это тоже затронуло' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const block = page.getByTestId('ticket-known-problem');
  await expect(block).toBeVisible();
  await expect(block).toContainText(publicTitle);
  await expect(block).not.toContainText('E2E известная');
  expect(await fits(page)).toBe(true);
  expect(await seriousAxe(page)).toEqual([]);

  for (const width of [1280, 768, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/ru/problems');
    await expect(page.getByTestId('public-problems')).toContainText(publicTitle);
    await expect(page.getByTestId('public-problems')).not.toContainText('E2E известная');
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);
  // Блок в обращении и баннер на узком экране тоже без прокрутки вбок.
  await page.goBack();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`${ERROR_CODE}: Накладная №6 от 03.03.2026 не проведена`);
  await expect(page.getByTestId('known-problem-banner')).toBeVisible();
  expect(await fits(page)).toBe(true);
  await context.close();
});
