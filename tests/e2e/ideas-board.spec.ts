import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';

// Доска идей и страница идеи (план M7, задача 5; ТЗ 8.3, FR-IDEA-04, 13, 14). Клиент находит идею поиском, голосует на
// доске, на странице идеи видит машинный перевод с пометкой и раскрывает оригинал, подписывается. Текст идеи с
// разметкой выводится текстом (решение 13, хранимый XSS).

test.use({ storageState: CLIENT_STATE });
test.beforeEach(({}, info) => {
  test.skip(info.project.name === 'narrow', 'страница клиента проверяется на телефоне и ноутбуке');
});

const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());

/** Опубликованная идея другого клиента (Globex, если он уже входил, иначе ACME Trade) с оригиналом на английском. */
async function publishedIdea(title: string, body: string): Promise<{ ideaId: string; number: number }> {
  const [other] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id
       join hdu_organizations o on o.org_id = m.org_id where o.name in ('Globex', 'ACME Trade') and m.state = 'active'
      order by (o.name = 'Globex') desc limit 1`,
  );
  const [idea] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on) values ($1, $2, $3, 'en', 'open', now()) returning idea_id, number`,
    [other!.org_id, other!.user_id, other!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'en', $2, $3, repeat('a', 64))`, [idea!.idea_id, `${title} (original)`, `${body} original`]);
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash) values ($1, 'ru', $2, $3, true, 'machine', repeat('a', 64))`, [
    idea!.idea_id,
    title,
    body,
  ]);
  return { ideaId: idea!.idea_id, number: Number(idea!.number) };
}

test('поиск на доске, голос без перехода, машинный перевод с оригиналом в один клик, "Следить"; разметка выводится текстом', async ({ page }) => {
  const word = tag();
  const xss = `<img src=x onerror="window.__xss=1"> **жирный** [ссылка](javascript:alert(1))`;
  const idea = await publishedIdea(`${word} экспорт заказов`, `Описание ${xss}`);
  await page.goto(`/ru/ideas?q=${encodeURIComponent(word)}`);
  const card = page.getByTestId('ideas-board').locator(`[data-idea="${idea.number}"]`);
  await expect(card).toContainText(`${word} экспорт заказов`);
  await expect(card).toContainText('Машинный перевод');
  await expect(page.getByTestId('cycle-countdown')).toContainText('Отбор за');
  await card.getByTestId('vote-button').click();
  await expect(card.getByTestId('vote-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await dbRows<{ vote_count: number }>(`select vote_count from hdi_ideas where idea_id = $1`, [idea.ideaId]))[0]?.vote_count).toBe(1);

  await card.getByRole('link', { name: `${word} экспорт заказов` }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${word} экспорт заказов`);
  await expect(page.getByTestId('idea-body')).toContainText('<img src=x onerror=');
  await expect(page.getByTestId('idea-body').locator('img, a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  const original = page.getByTestId('idea-original');
  await expect(original.getByText(`${word} экспорт заказов (original)`)).toBeHidden();
  await original.getByText('Показать оригинал').click();
  await expect(original.getByText(`${word} экспорт заказов (original)`)).toBeVisible();

  await page.getByRole('button', { name: 'Следить' }).click();
  await expect(page.getByRole('button', { name: 'Не следить' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('чужая идея на модерации даёт "Не найдено"', async ({ page }) => {
  const [other] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id
       join hdu_organizations o on o.org_id = m.org_id where o.name <> 'ACME Trade' and m.state = 'active' limit 1`,
  );
  test.skip(!other, 'нет клиента другой организации');
  const [idea] = await dbRows<{ idea_id: string; number: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale) values ($1, $2, $3, 'ru') returning idea_id, number`,
    [other!.org_id, other!.user_id, other!.name],
  );
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', 'Секрет на модерации', 'Секрет', repeat('a', 64))`, [idea!.idea_id]);
  await page.goto(`/ru/ideas/${idea!.number}`);
  await expect(page.getByText('Секрет на модерации')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
});
