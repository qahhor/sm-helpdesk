import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Предустановленные правила (FR-AUTO-12; план M8, задача 10, решения 1 и 2): три встроенных уведомления портала
// видны в списке правил, их можно изменить и вернуть к исходному виду, нельзя удалить; сообщение дежурным о P1
// ставит фоновый процесс по событию создания обращения. База браузерных тестов общая: после каждого теста правилам
// возвращается поставочный вид.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.describe.configure({ mode: 'serial' });

const P1_NAME = 'P1: сообщение дежурным';
const P1_CONDITIONS = { match: 'all', items: [{ field: 'priority', op: 'is', values: ['p1'] }] };
/** Поставочный вид правила о P1: как в миграции 0067. */
const restoreP1 = () =>
  dbRows(`update hdw_rules set name = $1, conditions = $2, actions = '[{"action": "notify_oncall_p1"}]', is_stop = false, is_enabled = true, disabled_reason = null where pcode = 'p1_oncall'`, [
    P1_NAME,
    JSON.stringify(P1_CONDITIONS),
  ]);
test.beforeAll(restoreP1);
test.afterEach(restoreP1);

const main = (page: Page) => page.getByRole('main');
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

/** Обращение P1, как его создаёт клиент на портале. Возвращает номер. */
async function clientP1(browser: Browser, description: string): Promise<number> {
  const context = await browser.newContext({ storageState: CLIENT_STATE });
  const page = await context.newPage();
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(description);
  await page.getByLabel('Влияние на работу').selectOption({ label: 'Работа остановлена' });
  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  await context.close();
  return number;
}

test('список правил: три предустановленных правила', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/rules');
  for (const name of [P1_NAME, 'Нарушение срока: руководителю линии', 'Оценка 1-2: руководителю']) {
    const row = main(page).locator(`tr[data-rule="${name}"]`);
    await expect(row).toContainText('Предустановленное');
    await expect(row).toContainText('Включено');
  }
});

test('предустановленное правило: событие закрыто, удалить нельзя, условие добавлено и возвращён исходный вид', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/rules');
  await main(page).locator(`tr[data-rule="${P1_NAME}"]`).getByRole('link', { name: P1_NAME, exact: true }).click();
  await expect(page).toHaveURL(/\/agent\/settings\/rules\/[0-9a-f-]{36}$/);
  // Событие не меняется; правило срабатывает ещё и на смену приоритета.
  await expect(page.getByLabel('Событие')).toBeDisabled();
  await expect(page.getByLabel('Событие')).toHaveValue('ticket_created');
  await expect(main(page)).toContainText('Событие предустановленного правила не меняется. Правило срабатывает ещё и на событие «Приоритет изменён».');
  // Собственное действие правила выбрано и названо словами.
  await expect(page.getByLabel('Действие 1: Что сделать')).toHaveValue('notify_oncall_p1');
  await expect(page.getByLabel('Действие 1: Что сделать').locator('option:checked')).toHaveText('Сообщить дежурным о P1 (один раз, пока нет первого ответа)');
  // Удаления нет, есть "Вернуть исходное".
  await expect(page.getByRole('button', { name: 'Удалить правило' })).toHaveCount(0);
  await expect(main(page)).toContainText('Предустановленное правило нельзя удалить. Его можно выключить.');
  expect(await seriousAxe(page)).toEqual([]);

  // Администратор добавляет условие "категория клиента A" и сохраняет.
  await page.getByRole('button', { name: 'Условие', exact: true }).click();
  await page.getByLabel('Условие 2: Поле').selectOption({ label: 'Категория клиента' });
  await page.getByLabel('Условие 2: Значение', { exact: true }).selectOption({ label: 'A' });
  await page.getByRole('button', { name: 'Условие 2: Значение: Добавить значение' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/done=saved/);
  await expect(main(page).locator('[data-condition="2"] [data-picked]')).toHaveText(['A']);
  const saved = await dbRows<{ conditions: { items: unknown[] }; is_enabled: boolean }>(`select conditions, is_enabled from hdw_rules where pcode = 'p1_oncall'`);
  expect(saved[0]?.conditions.items).toHaveLength(2);
  // Правка не выключила правило.
  expect(saved[0]?.is_enabled).toBe(true);

  // "Вернуть исходное": условие исчезло, правило как в поставке, запись в журнале аудита.
  await page.getByRole('button', { name: 'Вернуть исходное' }).click();
  await expect(page).toHaveURL(/done=restored/);
  await expect(main(page).getByRole('status').first()).toContainText('Правилу возвращён исходный вид.');
  await expect(main(page).locator('[data-condition]')).toHaveCount(1);
  expect(await dbRows(`select name, conditions, actions, is_enabled from hdw_rules where pcode = 'p1_oncall'`)).toEqual([
    { name: P1_NAME, conditions: P1_CONDITIONS, actions: [{ action: 'notify_oncall_p1' }], is_enabled: true },
  ]);
  const audit = await dbRows<{ action: string }>(
    `select action from hdc_audit_log where object_id = (select rule_id::text from hdw_rules where pcode = 'p1_oncall') order by created_on desc, audit_id desc limit 1`,
  );
  expect(audit[0]?.action).toBe('rule.restored');
});

test('новое обращение P1: фоновый процесс ставит сообщение дежурным, история обращения без записи о правиле', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const number = await clientP1(browser, `Склад стоит, отгрузки нет ${Date.now()}`);
  const queued = () =>
    dbRows<{ channel: string }>(`select o.channel from hdn_outbox o join hdt_tickets t using (ticket_id) where t.number = $1 and o.template = 'oncall_p1' order by o.channel`, [number]);
  await expect.poll(async () => (await queued()).map((row) => row.channel), { timeout: 90_000, intervals: [500] }).toEqual(['email', 'telegram']);
  // Срабатывание записано в журнале правила; история обращения прежняя.
  expect(await dbRows(`select r.result from hdw_rule_runs r join hdw_rules x using (rule_id) join hdt_tickets t using (ticket_id) where x.pcode = 'p1_oncall' and t.number = $1`, [number])).toEqual([
    { result: 'applied' },
  ]);
  await signInStaff(page, staffAccount('admin'));
  await page.goto(`/ru/agent/tickets/SUP-${number}`);
  await expect(main(page).getByText('Склад стоит, отгрузки нет').first()).toBeVisible();
  await expect(main(page).locator('[data-event="rule"]')).toHaveCount(0);
});
