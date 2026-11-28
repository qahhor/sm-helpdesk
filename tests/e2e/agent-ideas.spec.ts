import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Идеи на рабочем месте (план M7, задача 6; ТЗ FR-IDEA-03, 15, 8.11). Администратор (модератор идей) видит идею во
// вкладке "Модерация", текст клиента с разметкой выводится текстом, публикует идею с отметкой "Проверено" и видит
// разбивку голосов по организациям без имён. Сотрудник первой линии видит карточку без модерации и без разбивки.
// Вкладка "Модерация" показывает 30 самых старых идей на модерации: остаток прошлых прогонов отклоняет
// tests/e2e/global-setup.ts, поэтому идея теста попадает на страницу при любом числе прошлых прогонов.

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
});

const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());

async function pendingIdea(title: string, body: string): Promise<{ ideaId: string; number: number; voter: string }> {
  const [author] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id where m.state = 'active' order by m.created_on limit 1`,
  );
  const [idea] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale) values ($1, $2, $3, 'ru') returning idea_id, number`,
    [author!.org_id, author!.user_id, author!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', $2, $3, repeat('a', 64))`, [idea!.idea_id, title, body]);
  // Голос за идею на модерации ставит только её автор от своего имени (решение 4): строка с параметрами, триггеры
  // работают, переменные актора автора ставятся в той же команде, как их ставит withActor (итоговая проверка M7, M5).
  await dbRows(
    `insert into hdi_votes (org_id, idea_id, user_id)
     select $1::uuid, $2::uuid, $3::uuid from (select set_config('app.actor_type', 'client', true), set_config('app.user_id', $4, true),
                                    set_config('app.org_id', $5, true), set_config('app.org_role', 'client_user', true)) actor`,
    [author!.org_id, idea!.idea_id, author!.user_id, author!.user_id, author!.org_id],
  );
  return { ideaId: idea!.idea_id, number: Number(idea!.number), voter: author!.name };
}

test('модератор публикует идею с находкой после отметки "Проверено"; разбивка без имён; первая линия без модерации', async ({ browser }) => {
  const word = tag();
  const idea = await pendingIdea(`${word} <b>жирный</b> заголовок`, 'Звоните +998 90 123 45 67 <script>window.__xss=1</script>');
  const admin = await browser.newContext({ storageState: storageStateOf('admin') });
  const page = await admin.newPage();
  await page.goto('/ru/agent/ideas');
  const row = page.getByTestId('agent-ideas').locator(`[data-idea="${idea.number}"]`);
  await expect(row).toContainText(`${word} <b>жирный</b> заголовок`);
  await row.getByRole('link').click();
  await expect(page.getByTestId('agent-idea-body')).toContainText('<script>window.__xss=1</script>');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.getByTestId('breakdown-orgs')).toBeVisible();
  await expect(page.getByTestId('breakdown-orgs')).not.toContainText(idea.voter);
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('В тексте есть данные клиента')).toBeVisible();
  await page.getByLabel('Проверено: данных клиента в тексте нет').check();
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Идея опубликована.')).toBeVisible();
  await expect.poll(async () => (await dbRows<{ status: string }>(`select status from hdi_ideas where idea_id = $1`, [idea.ideaId]))[0]?.status).toBe('open');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
  await admin.close();

  const l1 = await browser.newContext({ storageState: storageStateOf('l1') });
  const other = await l1.newPage();
  await other.goto(`/ru/agent/ideas/${idea.number}`);
  await expect(other.getByTestId('agent-idea')).toBeVisible();
  await expect(other.getByRole('button', { name: 'Отклонить' })).toHaveCount(0);
  await expect(other.getByTestId('breakdown-orgs')).toHaveCount(0);
  await l1.close();
});
