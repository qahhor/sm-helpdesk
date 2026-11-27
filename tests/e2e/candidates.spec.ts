import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Кандидат в решение (ТЗ FR-CAND-04, 06, 09; план M5c, задача 10, решения 29, 30): сотрудник открывает очередь,
// делает кандидата черновиком решения, отмечает каждую находку недоверенного текста и публикует; подсказка клиента
// находит решение только после публикации. Очередь и карточка на трёх ширинах без прокрутки вбок. Кандидата готовит
// фоновый процесс по закрытому обращению; здесь он вставляется в базу напрямую (модель в браузерных тестах не нужна).

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'три ширины проверяет сам тест');
});
test.use({ storageState: storageStateOf('l2') });

const MODULE_CODE = 'e2e-candidates';
const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const seriousAxe = async (page: Page) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('кандидат стал черновиком, опубликован после отметок, подсказка его находит', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const word = tag();
  const title = `Реестр ${word} не выгружается в банк`;
  const [ticket] = await dbRows<{ ticket_id: string; org_id: string }>(`select ticket_id, org_id from hdt_tickets t where not exists (select 1 from hda_candidate_sources s where s.ticket_id = t.ticket_id) order by created_on desc limit 1`);
  const [row] = await dbRows<{ candidate_id: string }>(
    `insert into hda_solution_candidates (locale, title, problem, steps, findings, source_count, org_count) values ('ru', $1, $2, $3, $4, 1, 1) returning candidate_id`,
    [title, `Реестр ${word} не выгружается при отправке в банк.`, JSON.stringify(['Откройте настройки шлюза банка.', 'Выполните sudo systemctl restart gateway']), JSON.stringify([])],
  );
  await dbRows(`insert into hda_candidate_sources (org_id, candidate_id, ticket_id) values ($1, $2, $3)`, [ticket!.org_id, row!.candidate_id, ticket!.ticket_id]);

  await page.goto('/ru/agent/candidates');
  await expect(page.getByTestId('agent-candidates')).toBeVisible();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `${width}`).toBe(true);
  }
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByTestId('candidate-sources').getByRole('link')).toHaveCount(1);
  expect(await seriousAxe(page)).toEqual([]);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fits(page), `${width}`).toBe(true);
  }
  await page.getByRole('button', { name: 'Сделать черновиком решения' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
  const number = Number(/solutions\/(\d+)/.exec(page.url())?.[1]);

  // Модуль и аудитория "клиентам" (сотрудник меняет их сам перед публикацией).
  await dbRows(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Банк (кандидаты)"}') on conflict (code) do nothing`, [MODULE_CODE]);
  await dbRows(`update hdk_articles set audience = 'clients', module_id = (select module_id from hdr_product_modules where code = $2) where number = $1`, [number, MODULE_CODE]);
  await page.reload();
  const review = page.getByTestId('solution-review');
  const untrusted = review.getByTestId('solution-untrusted');
  await expect(untrusted).toBeVisible();
  const publish = review.getByRole('button', { name: 'Опубликовать' });
  // Пока каждая находка не отмечена, публикации нет.
  await expect(publish).toBeDisabled();
  const boxes = untrusted.getByRole('checkbox');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await dbRows<{ n: number }>(`select count(*)::int as n from hdk_search_documents d join hdk_articles a on a.article_id = d.ref_id where a.number = $1 and d.embedding is not null`, [number]))[0]?.n, { timeout: 30_000 })
    .toBe(1);

  const client = await browser.newContext({ storageState: CLIENT_STATE });
  const portal = await client.newPage();
  await portal.goto('/ru/tickets/new');
  await expect(portal.locator('form[data-ready]').first()).toBeAttached();
  await portal.getByLabel('Что случилось?').fill(`Реестр ${word} не выгружается в банк, что делать`);
  await expect(portal.getByTestId('suggestions').getByRole('link', { name: title })).toBeVisible({ timeout: 10_000 });
  await client.close();
});
