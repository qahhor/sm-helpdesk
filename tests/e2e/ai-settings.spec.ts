import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount } from './helpers/staff';

// Раздел "AI-помощник" настроек (план M5b, задача 1; FR-ADM-09, FR-AI-17). Администратор со свежим входом меняет
// пределы и модели; после смены модели видит просьбу прогнать проверочный набор. Общий переключатель здесь не
// включается: браузерные тесты идут параллельно, и включённый помощник забрал бы новые обращения других тестов.

// Настройки меняет только свежий вход администратора: тест входит сам, без сохранённой сессии.
test.use({ storageState: { cookies: [], origins: [] } });

const main = (page: Page) => page.getByRole('main');

test('администратор задаёт пределы и модели; смена модели просит прогнать набор; доступность и ширина экрана', async ({ page }) => {
  await signInStaff(page, staffAccount('admin'));
  await page.goto('/ru/agent/settings/ai');
  await expect(main(page).getByRole('heading', { name: 'Расход за месяц' })).toBeVisible();
  await expect(main(page).getByTestId('ai-spend')).toContainText('Израсходовано');
  // Помощник по умолчанию выключен (решение 4: включает администратор).
  await expect(main(page).getByLabel('Помощник отвечает первым')).not.toBeChecked();

  await main(page).getByLabel('Вызовов в сутки на пользователя').fill('25');
  await main(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(main(page).getByText('Настройки AI сохранены.')).toBeVisible();
  await expect(main(page).getByLabel('Вызовов в сутки на пользователя')).toHaveValue('25');

  const firstLine = main(page).getByLabel('Ответ первой линии');
  await expect(firstLine).toHaveValue('claude-sonnet-5-5');
  await firstLine.selectOption('claude-opus-5-5');
  await main(page).getByRole('button', { name: 'Сохранить модели' }).click();
  await expect(main(page).getByText('После смены модели прогоните проверочный набор.')).toBeVisible();
  await expect(main(page).getByLabel('Ответ первой линии')).toHaveValue('claude-opus-5-5');

  expect((await new AxeBuilder({ page }).include('main').analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  // Содержимое страницы не шире экрана ни на одной из трёх ширин.
  expect(await main(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // Значения по умолчанию возвращаются: другие тесты ждут модели и пределы по умолчанию.
  await dbRows(`delete from hdc_settings where code in ('ai.models', 'ai.user_daily_limit', 'ai.org_daily_limit', 'ai.min_score', 'ai.monthly_budget_usd', 'ai.cutoff_share', 'ai.triage_enabled', 'ai.triage_fields_off', 'ai.enabled')`);
});
