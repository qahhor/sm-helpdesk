import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';

// Подача идеи и похожие идеи на форме (план M7, задачи 2 и 3; ТЗ FR-IDEA-01, 02, FR-TK-01). Клиент печатает заголовок,
// видит опубликованную похожую идею и голосует за неё не уходя со страницы; текст с телефоном даёт предупреждение,
// "Отправить всё равно" отправляет идею на модерацию. Индекс похожих пишет фоновый процесс (ideas.index).

test.use({ storageState: CLIENT_STATE });
test.beforeEach(({}, info) => {
  test.skip(info.project.name === 'narrow', 'страница клиента проверяется на телефоне и ноутбуке');
});

/** Слово из букв без чисел: уникальная метка заголовка. */
const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());

test('похожая идея с голосом без ухода со страницы, предупреждение о телефоне и экран "Идея отправлена на проверку"', async ({ page }) => {
  const word = tag();
  // Опубликованная идея (клиента Globex, если он уже входил, иначе ACME Trade): строка идеи и строка индекса похожих
  // (её же пишет задание ideas.index).
  const [other] = await dbRows<{ org_id: string; user_id: string; name: string }>(
    `select m.org_id, m.user_id, u.name from hdu_memberships m join auth."user" u on u.id = m.user_id
       join hdu_organizations o on o.org_id = m.org_id where o.name in ('Globex', 'ACME Trade') and m.state = 'active'
      order by (o.name = 'Globex') desc limit 1`,
  );
  const title = `${word} печать накладных пачкой`;
  const [idea] = await dbRows<{ idea_id: string }>(
    `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on) values ($1, $2, $3, 'ru', 'open', now()) returning idea_id`,
    [other!.org_id, other!.user_id, other!.name],
  );
  const body = 'Печатать все накладные дня одной кнопкой';
  await dbRows(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', $2, $3, repeat('a', 64))`, [idea!.idea_id, title, body]);
  await dbRows(`insert into hdk_search_documents (ref_id, kind, locale, title, body_text, audience) values ($1, 'idea', 'ru', $2, $3, 'clients')`, [idea!.idea_id, title, body]);

  // Из формы обращения ведёт ссылка "Предложите идею" (FR-TK-01).
  await page.goto('/ru/tickets/new');
  await page.getByRole('link', { name: 'Предложите идею' }).click();
  await expect(page).toHaveURL(/\/ru\/ideas\/new$/);
  await expect(page.locator('form[data-ready]')).toBeVisible();
  await page.getByLabel('Заголовок').fill(`${word} печать накладных`);
  const similar = page.getByTestId('similar-ideas');
  // Карточка своей метки: в общей базе браузерных тестов могут быть похожие идеи прошлых запусков.
  const card = similar.getByRole('listitem').filter({ hasText: word });
  await expect(card.getByRole('link', { name: title })).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: 'Голосовать' }).click();
  await expect(card.getByRole('button', { name: 'Вы проголосовали' })).toBeVisible();
  await expect.poll(async () => (await dbRows<{ vote_count: number }>(`select vote_count from hdi_ideas where idea_id = $1`, [idea!.idea_id]))[0]?.vote_count).toBe(1);
  await expect(page).toHaveURL(/\/ru\/ideas\/new$/);

  await page.getByLabel('Описание').fill('Хотим печатать все накладные дня, звоните +998 90 123 45 67');
  await page.getByRole('button', { name: 'Отправить идею' }).click();
  await expect(page.getByTestId('idea-findings')).toContainText('номер телефона');
  await page.getByRole('button', { name: 'Отправить всё равно' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Идея отправлена на проверку');
  const number = Number(new URL(page.url()).searchParams.get('sent'));
  const [mine] = await dbRows<{ status: string; vote_count: number }>(`select status, vote_count from hdi_ideas where number = $1`, [number]);
  expect(mine).toEqual({ status: 'pending_review', vote_count: 1 });
});

test('форма новой идеи без серьёзных нарушений доступности и без прокрутки вбок на 360 px (UX-C-12)', async ({ page }) => {
  await page.goto('/ru/ideas/new');
  await expect(page.locator('form[data-ready]')).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// Проверка интерфейса, второй проход (F3; UX-C-10): ошибка сервера стояла только в начале формы, за экраном телефона,
// и фокус оставался на странице: после нажатия "Отправить идею" человек не видел ничего.
test('после ошибки сервера сообщение видно на экране и получает фокус, модуль и флажок остаются', async ({ page }) => {
  await page.goto('/ru/ideas/new');
  await expect(page.locator('form[data-ready]')).toBeVisible();
  await page.getByLabel('Заголовок').fill('');
  await page.getByLabel('Описание').fill('Печатать все накладные дня одной кнопкой, без открытия каждой.');
  const modulePick = page.locator('#idea-module');
  const hasModules = (await modulePick.count()) > 0;
  if (hasModules) await modulePick.selectOption({ index: 1 });
  const chosen = hasModules ? await modulePick.inputValue() : '';
  await page.locator('#idea-show-org').check();
  await page.getByRole('button', { name: 'Отправить идею' }).click();
  const error = page.getByTestId('idea-form-error');
  await expect(error).toBeVisible();
  await expect(error).toBeFocused();
  await expect(error).toBeInViewport();
  if (hasModules) await expect(modulePick).toHaveValue(chosen);
  await expect(page.locator('#idea-show-org')).toBeChecked();
});
