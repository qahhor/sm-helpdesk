import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// "AI-сотрудники" (FR-AGT-02, FR-ADM-13, экран 8.12; план M8b, задача 3): администратор выпускает токен и видит
// значение один раз, после перезагрузки значения нет нигде; на странице токена отзывает его с подтверждением. Три
// ширины экрана без горизонтальной прокрутки. База браузерных тестов общая: токены теста названы с меткой времени.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const main = (page: Page) => page.getByRole('main');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('администратор выпускает токен: значение один раз, в базе только хеш; затем отзывает его с подтверждением', async ({ page }) => {
  test.setTimeout(180_000);
  const name = `E2E Hermes ${Date.now()}`;
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/agents');
  await expect(page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'AI-сотрудники' })).toHaveAttribute('aria-current', 'page');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);

  // Неверный адрес: форма не принимает, введённое остаётся.
  const form = page.locator('#issue');
  await form.getByLabel('Имя').fill(name);
  await form.getByRole('checkbox', { name: /search_tickets/ }).check();
  await form.getByRole('checkbox', { name: /add_internal_note/ }).check();
  await form.getByLabel('Разрешённые адреса').fill('example.com');
  await form.getByRole('button', { name: 'Выпустить токен' }).click();
  await expect(main(page).getByRole('alert').first()).toContainText('Проверьте поля');
  await expect(form.getByLabel('Имя')).toHaveValue(name);
  expect(await dbRows(`select 1 from hda_agent_tokens where name = $1`, [name])).toEqual([]);

  await form.getByLabel('Разрешённые адреса').fill('10.0.3.12\n2001:db8:1:2::/64');
  await form.getByRole('button', { name: 'Выпустить токен' }).click();
  const shown = main(page).locator('[data-agent-token]');
  await expect(shown).toContainText('показывает его один раз');
  const value = (await shown.locator('[data-token-value]').innerText()).trim();
  expect(value).toMatch(/^hub_at_[A-Za-z0-9_-]{43}$/);
  await expect(shown.getByRole('button', { name: 'Скопировать токен' })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  const [stored] = await dbRows<{ token_id: string; token_hash: string; token_last4: string; tools: string[] }>(
    `select token_id, token_hash, token_last4, tools from hda_agent_tokens where name = $1`,
    [name],
  );
  expect(stored?.token_last4).toBe(value.slice(-4));
  expect(stored?.token_hash).not.toContain(value);
  expect(stored?.tools).toEqual(['search_tickets', 'add_internal_note']);

  // После перезагрузки значения нет ни на странице, ни в списке; в списке имя, число инструментов и окончание.
  await page.reload();
  expect(await page.content()).not.toContain(value);
  const row = main(page).locator(`tr[data-agent-token-row="${name}"]`);
  await expect(row).toContainText('чтение 1, запись 1');
  await expect(row).toContainText(`Окончание токена: ${value.slice(-4)}`);
  await expect(row).toContainText('Действует');
  await expect(row).toContainText('0 из 2000');

  // Страница токена: правка, журнал вызовов, отзыв с подтверждением.
  await row.getByRole('link', { name }).click();
  await expect(page).toHaveURL(new RegExp(`/agent/settings/agents/${stored?.token_id}$`));
  await expect(main(page)).toContainText('Вызовов пока нет.');
  expect(await page.content()).not.toContain(value);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `ширина ${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);

  await main(page).getByRole('button', { name: 'Отозвать токен' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Отозвать токен ${name}?`);
  await dialog.getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(main(page).getByRole('status').first()).toContainText('Токен отозван');
  await expect(main(page)).toContainText('Отозван');
  await expect(main(page).getByRole('button', { name: 'Отозвать токен' })).toHaveCount(0);
  const [revoked] = await dbRows<{ revoked: boolean }>(`select revoked_at is not null as revoked from hda_agent_tokens where token_id = $1`, [stored?.token_id]);
  expect(revoked?.revoked).toBe(true);
  const audit = await dbRows<{ action: string }>(`select action from hdc_audit_log where object_id = $1 order by created_on`, [stored?.token_id]);
  expect(audit.map((r) => r.action)).toEqual(['agent.token_issued', 'agent.token_revoked']);
});
