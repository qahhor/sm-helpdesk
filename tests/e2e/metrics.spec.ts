import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount, storageStateOf } from './helpers/staff';

// Показатели (FR-MET-01, 03, 04, 07, 10; план M8, задача 9, решения 14-16): сотрудник открывает страницу и меняет
// период, Customer Care скачивает срез по организациям и пишет заметку о разборе низкой оценки, первая линия
// выгрузку не получает. Проверяется на ноутбуке.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const resetLimits = () =>
  dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%' or code like 'ticket-reply:user:%' or code like 'ticket-action:user:%' or code like 'metrics-export:user:%'`);

/** Обращение, как его создаёт клиент на портале. Возвращает номер. */
async function clientTicket(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await resetLimits();
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

const main = (page: Page) => page.getByRole('main');
const stat = (page: Page, id: string) => main(page).locator(`[data-stat="${id}"] dd`).first();
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('первая линия', () => {
  test.use({ storageState: storageStateOf('l1') });

  test('сотрудник открывает показатели из меню, видит числа и меняет период', async ({ page, browser }) => {
    await clientTicket(browser, `Обращение для показателей ${Date.now()}`);
    await page.goto('/ru/agent');
    await page.getByRole('button', { name: 'Аналитика' }).click();
    await page.getByRole('menuitem', { name: 'Показатели' }).click();
    await expect(page).toHaveURL(/\/ru\/agent\/metrics$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Показатели');
    // Без выбора показаны 30 дней: в них есть только что созданное обращение.
    await expect(main(page).getByLabel('Период')).toHaveValue('30');
    const created30 = Number((await stat(page, 'created').innerText()).replace(/\D/g, ''));
    expect(created30).toBeGreaterThan(0);
    // Рядом с созданными: завершённые за период, когда бы ни созданы (FR-MET-01).
    await expect(main(page).locator('[data-stat="finished"]')).toContainText('Завершено за период');
    await expect(stat(page, 'finished')).toHaveText(/^[\d\s]+$/);
    await expect(main(page).locator('[data-block="sources"] tr[data-source="portal"]')).toBeVisible();
    // Четыре линии с вехи M5b: AI-помощник, первая, вторая, разработка (FR-LINE-08).
    await expect(main(page).locator('[data-block="lines"] tbody tr')).toHaveCount(4);
    // Показатели AI-помощника (FR-MET-06, план M5b, задача 10).
    await expect(main(page).locator('[data-block="assistant"] [data-stat="ai-resolved"]')).toBeVisible();
    await expect(main(page).locator('[data-block="assistant"] [data-stat="ai-spend"]')).toBeVisible();
    // Каналы FR-MET-10 (план M6, задача 8): портал, виджет, почта и созданные сотрудником, всегда в этом порядке.
    await expect(main(page).locator('[data-block="channels"] tbody tr')).toHaveText([/^Портал/, /^Виджет/, /^Почта/, /^Создано сотрудником/]);
    // Среза по организациям и выгрузки у первой линии нет (решение 14).
    await expect(main(page).locator('[data-breakdown]')).toHaveCount(0);
    await expect(main(page).locator('[data-block="export"]')).toHaveCount(0);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

    await main(page).getByLabel('Период').selectOption('7');
    await main(page).getByRole('button', { name: 'Показать' }).click();
    await expect(page).toHaveURL(/period=7/);
    await expect(main(page).getByLabel('Период')).toHaveValue('7');
    const created7 = Number((await stat(page, 'created').innerText()).replace(/\D/g, ''));
    expect(created7).toBeGreaterThan(0);
    // Неделя входит в 30 дней. Соседние тесты создают обращения, поэтому 30 дней читаются заново после недели.
    await main(page).getByLabel('Период').selectOption('30');
    await main(page).getByRole('button', { name: 'Показать' }).click();
    await expect(page).toHaveURL(/period=30/);
    expect(Number((await stat(page, 'created').innerText()).replace(/\D/g, ''))).toBeGreaterThanOrEqual(created7);

    // Свой период без обращений: пустое состояние вместо нулей.
    await page.goto('/ru/agent/metrics?period=custom&from=2020-01-01&to=2020-01-07');
    await expect(main(page).getByRole('heading', { name: 'За этот период обращений нет' })).toBeVisible();
    await expect(main(page).locator('[data-stat]')).toHaveCount(0);
    // Негодный период: предупреждение и последние 30 дней.
    await page.goto('/ru/agent/metrics?period=custom&from=2020-01-01&to=2026-01-07');
    await expect(main(page).getByRole('alert')).toContainText('Период задан неверно');
    await expect(main(page).getByLabel('Период')).toHaveValue('30');

    // Ширина 1100: страница не прокручивается вбок. Упрощённый вид 360: содержимое страницы не шире экрана
    // (сама верхняя панель рабочего места на 360 шире экрана на всех страницах, это не часть этой задачи).
    await page.goto('/ru/agent/metrics');
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(stat(page, 'created')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(stat(page, 'created')).toBeVisible();
    expect(await page.evaluate(() => { const content = document.querySelector('main') as HTMLElement; return content.scrollWidth <= content.clientWidth && content.getBoundingClientRect().right <= window.innerWidth; })).toBe(true);
  });

  test('первая линия получает 403 на адресе выгрузки, без входа ответ 401', async ({ page, browser }) => {
    await resetLimits();
    const response = await page.request.get('/ru/agent/metrics/export?report=orgs&period=30');
    expect(response.status()).toBe(403);
    expect(await response.text()).toBe('');
    // Без сохранённой сессии: созданный вручную контекст иначе берёт сессию сотрудника из настроек теста.
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    expect((await anonymous.request.get('/ru/agent/metrics/export?report=orgs&period=30')).status()).toBe(401);
    await anonymous.close();
    const client = await browser.newContext({ storageState: CLIENT_STATE });
    expect([401, 403, 404]).toContain((await client.request.get('/ru/agent/metrics/export?report=requests&period=30')).status());
    await client.close();
  });
});

test.describe('Customer Care', () => {
  test.use({ storageState: storageStateOf('care') });

  test('care скачивает срез по организациям: файл CSV с меткой порядка байтов, выгрузка записана в журнал', async ({ page, browser }) => {
    await clientTicket(browser, `Обращение для выгрузки ${Date.now()}`);
    await resetLimits();
    const before = Number((await dbRows<{ n: string }>(`select count(*) as n from hdc_audit_log where action = 'metrics.exported'`))[0]?.n);
    await page.goto('/ru/agent/metrics');
    await expect(main(page).locator('[data-breakdown="org"] tbody tr').first()).toBeVisible();
    await expect(main(page).locator('[data-breakdown="module"]')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), main(page).getByRole('link', { name: 'Организации', exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(/^smartup-hub-orgs-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);

    const response = await page.request.get('/ru/agent/metrics/export?report=orgs&period=30');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(headers['content-disposition']).toMatch(/^attachment; filename="smartup-hub-orgs-[\d-]+\.csv"$/);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const body = await response.body();
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = body.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe('Организация;Создано;Решено;Первый ответ в срок, %;Решение в срок, %;Оценок;Средняя оценка');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)).toBe('');
    // Две выгрузки: по нажатию и по запросу.
    const after = Number((await dbRows<{ n: string }>(`select count(*) as n from hdc_audit_log where action = 'metrics.exported'`))[0]?.n);
    expect(after - before).toBe(2);
    // Негодный вид выгрузки и негодный период: 400, файла нет.
    expect((await page.request.get('/ru/agent/metrics/export?report=everything&period=30')).status()).toBe(400);
    expect((await page.request.get('/ru/agent/metrics/export?report=orgs&period=custom&from=2020-01-01&to=2026-01-01')).status()).toBe(400);
  });

  test('care пишет заметку о разборе низкой оценки; клиент заметки не видит', async ({ page, browser }) => {
    const stamp = Date.now();
    const number = await clientTicket(browser, `Обращение с низкой оценкой ${stamp}`);
    // Обращение закрыто и оценено на двойку: так его оставил бы клиент после решения.
    await dbRows(`update hdt_tickets set status = 'closed', closed_on = now(), resolved_on = now(), csat_score = 2, csat_reason = 'slow', csat_comment = $2 where number = $1`, [number, `Долго ${stamp}`]);
    await page.goto('/ru/agent/metrics?period=7');
    const row = main(page).locator(`tr[data-low="${number}"]`);
    await expect(row).toContainText('Долго ждал ответа');
    await expect(row).toContainText(`Долго ${stamp}`);
    await expect(row).toContainText('Разбора пока нет');
    await row.getByText('Написать заметку').click();
    const note = `Разобрали с клиентом ${stamp}: ответ задержали из-за передачи между линиями`;
    await row.getByLabel(`Заметка о разборе обращения SUP-${number}`).fill(note);
    await row.getByRole('button', { name: 'Сохранить заметку' }).click();
    await expect(page).toHaveURL(/period=7&done=reviewed/);
    await expect(main(page).getByRole('status').filter({ hasText: 'Заметка о разборе сохранена' })).toBeVisible();
    await expect(row.locator('[data-review-note]')).toHaveText(note);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);

    // В истории обращения сотрудник видит запись о разборе, клиент на странице обращения не видит ничего.
    await page.goto(`/ru/agent/tickets/SUP-${number}`);
    await expect(main(page).locator('[data-event="csat_review"]')).toContainText('заметка о разборе оценки');
    const clientContext = await browser.newContext({ storageState: CLIENT_STATE });
    const client = await clientContext.newPage();
    await client.goto(`/ru/tickets/SUP-${number}`);
    await expect(client.getByRole('main').getByText(`Обращение с низкой оценкой ${stamp}`).first()).toBeVisible();
    expect(await client.content()).not.toContain('Разобрали с клиентом');
    expect(await client.content()).not.toContain('разборе');
    await clientContext.close();
  });
});

// Сводка пилота и отметка "откуда пришло" (план M9, задача 3, решения 11-13).
test.describe('пилот', () => {
  test.afterAll(async () => {
    await dbRows(`delete from hdc_settings where code = 'pilot.org_ids'`);
  });

  test('первая линия заводит обращение с отметкой Telegram; администратор отмечает пилот; care видит сводку', async ({ browser }) => {
    const [org] = await dbRows<{ org_id: string }>(`select org_id from hdu_organizations where name = 'ACME Trade' limit 1`);
    const stamp = Date.now().toString(36);
    await resetLimits();

    const l1Context = await browser.newContext({ storageState: storageStateOf('l1') });
    const l1 = await l1Context.newPage();
    await l1.goto(`/ru/agent/tickets/new?org=${org!.org_id}`);
    await l1.getByLabel('Что случилось').fill(`Клиент написал в чат поддержки ${stamp}`);
    // Без отметки форма не уходит: поле обязательное.
    await l1.getByRole('button', { name: 'Создать обращение' }).click();
    await expect(l1.getByLabel('Откуда пришло')).toHaveJSProperty('validity.valueMissing', true);
    await l1.getByLabel('Откуда пришло').selectOption('telegram');
    await l1.getByRole('button', { name: 'Создать обращение' }).click();
    await expect(l1).toHaveURL(/\/ru\/agent\/tickets\/SUP-\d+/);
    const number = Number(/SUP-(\d+)/.exec(l1.url())?.[1]);
    expect((await dbRows<{ intake_channel: string }>(`select intake_channel from hdt_tickets where number = $1`, [number]))[0]?.intake_channel).toBe('telegram');
    // Первой линии вкладка пилота не видна и не открывается.
    await l1.goto('/ru/agent/metrics');
    await expect(main(l1).getByRole('link', { name: 'Пилот' })).toHaveCount(0);
    expect((await l1.goto('/ru/agent/metrics/pilot'))!.status()).toBe(404);
    await l1Context.close();

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signInStaff(admin, staffAccount('admin'));
    await admin.goto(`/ru/agent/organizations/${org!.org_id}`);
    await admin.getByRole('button', { name: 'Отметить пилотной' }).click();
    await expect(main(admin).getByRole('status')).toContainText('Организация отмечена пилотной.');
    await expect(admin.getByTestId('org-pilot')).toHaveText('Организация входит в пилот и в сводку пилота.');
    await adminContext.close();

    const careContext = await browser.newContext({ storageState: storageStateOf('care') });
    const care = await careContext.newPage();
    await care.goto('/ru/agent/metrics?period=7');
    await main(care).getByRole('navigation', { name: 'Разделы показателей' }).getByRole('link', { name: 'Пилот' }).click();
    await expect(care).toHaveURL(/\/ru\/agent\/metrics\/pilot\?period=7/);
    await expect(main(care).getByRole('heading', { name: 'Сводка пилота' })).toBeVisible();
    await expect(main(care).getByText('Пилотные организации: ACME Trade')).toBeVisible();
    await expect(main(care).locator('[data-pilot-row]')).toHaveCount(10);
    // Две доли закрытых помощником: от обращений помощника и от всех обращений пилота (проверка M9, M3).
    await expect(main(care).locator('[data-pilot-row="ai_resolved"] th')).toContainText('из обращений, которые вёл помощник');
    await expect(main(care).locator('[data-pilot-row="ai_resolved_all"] th')).toContainText('из всех обращений пилотных клиентов');
    await expect(main(care).locator('[data-pilot-row="portal_share"]')).toContainText('не меньше 90%');
    await expect(main(care).locator('[data-pilot-row="telegram_share"] td').first()).not.toHaveText('нет данных');
    expect(await care.content()).not.toContain(`Клиент написал в чат поддержки ${stamp}`);
    const axe = await new AxeBuilder({ page: care }).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
    for (const width of [360, 768]) {
      await care.setViewportSize({ width, height: 800 });
      expect(await fits(care)).toBe(true);
    }
    await careContext.close();
  });
});
