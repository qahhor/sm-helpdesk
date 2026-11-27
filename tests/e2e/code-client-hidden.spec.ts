import { expect, type Page, test } from '@playwright/test';
import { uniqueReport } from '../helpers/code-scan';
import { callOk, e2eMcpClient, seedAgentForE2e } from './helpers/agent';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';

// Клиент знаний из кода не видит (веха M8c, задача 9; строка приёмки M8c раздела 16.2, строка 15.2 "Клиент
// запрашивает знания из кода или заметку AI-сотрудника: не найдено"; CLAUDE.md, FR-CODE-11). В обращении клиента с
// ошибкой, которую знает утверждённая запись, нет ни блока, ни условий, ни места в коде, ни заметки анализа; разделы
// "Знания из кода" клиенту закрыты.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'проверяется на ноутбуке');
});
test.use({ storageState: CLIENT_STATE });

const main = (page: Page) => page.getByRole('main');

test('клиент не видит знаний из кода: ни в своём обращении, ни по адресам раздела, ни заметки анализа', async ({ page }) => {
  test.setTimeout(180_000);
  const word = `H${Date.now().toString(36)}`;
  const agent = await seedAgentForE2e(['code_catalog_upsert', 'submit_code_analysis']);
  const mcp = e2eMcpClient(agent.value);
  const report = uniqueReport();
  report.errors[0]!.messageTemplates.ru = `Недостаточно остатка товара {product} на складе {warehouse}, партия ${word}`;
  await callOk(mcp, 'code_catalog_upsert', report);
  const key = report.errors[0]!.key;
  const [admin] = await dbRows<{ user_id: string }>(`select user_id from hdu_staff where role = 'admin' limit 1`);
  await dbRows(`update hda_code_error_entries set status = 'approved', approved_by = $2, approved_on = now() where key = $1`, [key, admin!.user_id]);

  await dbRows(`delete from hdc_rate_limits where code like 'ticket-create:user:%'`);
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]').first()).toBeAttached();
  await page.getByLabel('Что случилось?').fill(`ORA-20001: Недостаточно остатка товара Сыр на складе Юг, партия ${word}`);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const number = Number(/SUP-(\d+)/.exec(page.url())?.[1]);
  // Запрос анализа и заметка агента, как после "Разобрать по коду".
  const [ticket] = await dbRows<{ ticket_id: string; org_id: string }>(`select ticket_id, org_id from hdt_tickets where number = $1`, [number]);
  await dbRows(`insert into hda_code_analysis_requests (org_id, ticket_id, requested_by, source, due_on) values ($1, $2, $3, 'staff', now() + interval '10 minutes')`, [
    ticket!.org_id,
    ticket!.ticket_id,
    admin!.user_id,
  ]);
  await callOk(mcp, 'submit_code_analysis', {
    ticket_number: number,
    hypothesis: `Секретная гипотеза ${word}`,
    confidence: 0.6,
    locations: [{ object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 }],
    what_to_check: ['Остаток'],
    questions: [],
    similar_tickets: [],
    recommendation: '',
  });

  await page.reload();
  const content = main(page);
  await expect(content).toContainText(`партия ${word}`);
  for (const hidden of [report.errors[0]!.conditions, report.errors[0]!.userCause, 'Остаток по товару на складе заказа', 'ORDER_PKG', 'order_pkg.pkb', key, `Секретная гипотеза ${word}`, 'Что известно по коду', 'Анализ по коду'])
    await expect(content, hidden).not.toContainText(hidden);
  expect(await page.locator('[data-code-knowledge], [data-code-analysis], [data-agent-mark]').count()).toBe(0);

  // Разделы знаний из кода клиенту закрыты: вход сотрудника, а не содержимое.
  for (const path of ['/ru/agent/code-knowledge', `/ru/agent/code-knowledge/${encodeURIComponent(key)}`, '/ru/agent/code-knowledge/scans', '/ru/agent/code-knowledge/modules']) {
    const response = await page.goto(path);
    // Клиенту раздел отвечает "не найдено" или уводит на вход сотрудника.
    expect(response?.status() === 404 || !/\/agent\/code-knowledge/.test(new URL(page.url()).pathname), path).toBe(true);
    await expect(page.locator('body'), path).not.toContainText(report.errors[0]!.conditions);
  }
});
