import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { callOk, e2eMcpClient, seedAgentForE2e } from './helpers/agent';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Раздел "Сводки" (веха M8b, задача 10; 8.12 "Сводки"; FR-AGT-04, 07): AI-сотрудник пишет сводку через сервер MCP,
// сотрудник видит её в меню "Аналитика" с пометкой "не проверено", открывает карточку (текст обычным текстом) и
// отмечает "Просмотрено". Три ширины без горизонтальной прокрутки и проверка доступности.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});
test.use({ storageState: { cookies: [], origins: [] } });

const main = (page: Page) => page.getByRole('main');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('сводка AI-сотрудника: в списке с пометкой, карточка обычным текстом, "Просмотрено" снимает пометку', async ({ page }) => {
  test.setTimeout(180_000);
  const agent = await seedAgentForE2e(['create_report']);
  const title = `Утро ${Date.now()}`;
  const out = await callOk(e2eMcpClient(agent.value), 'create_report', { kind: 'morning', title, body: 'Новых обращений: 12.\n**не жирный** текст' });
  const id = (out.report as { id: string }).id;

  await signInStaff(page, staffAccount('l1'));
  await page.goto('/ru/agent');
  await page.getByRole('navigation').getByRole('link', { name: 'Сводки' }).first().click();
  await expect(page).toHaveURL(/\/ru\/agent\/digests$/);
  const row = main(page).locator(`tr[data-digest-row="${id}"]`);
  await expect(row).toContainText(title);
  await expect(row).toContainText('AI-сотрудник');
  await expect(row.locator('[data-agent-mark]')).toHaveText('AI-сотрудник, не проверено');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);

  await row.getByRole('link', { name: title }).click();
  const card = main(page).locator('[data-testid="agent-digest"]');
  await expect(card.locator('[data-agent-text]')).toContainText('**не жирный**');
  await expect(card.locator('strong')).toHaveCount(0);
  expect(await seriousAxe(page)).toEqual([]);
  await card.getByRole('button', { name: 'Просмотрено' }).click();
  await expect(main(page).getByRole('alert')).toContainText('Сводка отмечена просмотренной');
  await expect(card.locator('[data-agent-mark]')).toHaveCount(0);
  const [stored] = await dbRows<{ status: string }>(`select status from hda_agent_reports where report_id = $1`, [id]);
  expect(stored?.status).toBe('reviewed');
});
