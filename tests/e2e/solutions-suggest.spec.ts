import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Сценарий S1 на портале (план M5, задача 10; ТЗ 8.3 "Новое обращение с подсказкой", FR-SOL-08..13). Клиент печатает
// описание, через 400 мс видит опубликованное решение, поля формы свёрнуты; открывает решение; "Помогло" пишет исход
// сессии формы; "Не помогло" возвращает к форме с сохранённым описанием и раскрытыми полями, обращение создаётся и
// исход становится ticket_created. Векторы считает заглушка (EMBEDDINGS=stub), индекс пишет фоновый процесс.

test.use({ storageState: CLIENT_STATE });
test.beforeEach(({}, info) => {
  test.skip(info.project.name === 'narrow', 'страница клиента проверяется на телефоне и ноутбуке');
});

const MODULE_CODE = 'e2e-kb-suggest';
const editorArea = (page: Page) => page.locator('.doc-editor');
/** Метка из букв: уникальное слово в заголовке, без длинных чисел (они находка проверки FR-SOL-04). */
const tag = () =>
  Array.from({ length: 7 }, () => 'бвгджзклмнпрстфхцчшщ'[Math.floor(Math.random() * 20)])
    .join('')
    .replace(/^./, (c) => c.toUpperCase());

async function publishSolution(browser: Browser, title: string): Promise<number> {
  await dbRows(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Заказы (подсказка)", "uz": "Buyurtmalar (maslahat)", "en": "Orders (suggestions)"}') on conflict (code) do nothing`, [MODULE_CODE]);
  const context = await browser.newContext({ storageState: storageStateOf('l2') });
  const page = await context.newPage();
  await page.goto('/ru/agent/solutions/new');
  await page.getByLabel('Заголовок').fill(title);
  await page.getByLabel('Модуль').selectOption({ label: 'Заказы (подсказка)' });
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
  const number = Number(/solutions\/(\d+)/.exec(page.url())?.[1]);
  await editorArea(page).locator(':scope > p').first().click();
  await page.keyboard.type('При сохранении заказа появляется ошибка: на складе не хватает остатка.');
  await editorArea(page).locator('.node-step p').first().click();
  await page.keyboard.type('Откройте Склад, затем Остатки, и проверьте остаток товара');
  await expect(page.getByTestId('save-status')).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.getByTestId('solution-review').getByRole('button', { name: 'Опубликовать' }).click();
  await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
  await context.close();
  // Строку индекса с вектором пишет фоновый процесс (задача kb.index).
  await expect
    .poll(async () => (await dbRows<{ n: number }>(`select count(*)::int as n from hdk_search_documents d join hdk_articles a on a.article_id = d.ref_id where a.number = $1 and d.embedding is not null`, [number]))[0]?.n, { timeout: 30_000 })
    .toBe(1);
  return number;
}

async function typeProblem(page: Page, word: string): Promise<void> {
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]')).toBeVisible();
  await page.getByLabel('Что случилось?').fill(`При сохранении заказа ${word} выходит ошибка: нет остатка на складе`);
}

const outcomeOf = async (session: string) => (await dbRows<{ outcome: string; ticket_id: string | null }>(`select outcome, ticket_id from hdk_deflection_events where session_id = $1`, [session]))[0];

test('S1: подсказка, решение открыто, "Помогло" записано в исход сессии', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const word = tag();
  const title = `Заказ ${word} не сохраняется: нет остатка на складе`;
  const number = await publishSolution(browser, title);
  await typeProblem(page, word);
  const block = page.getByTestId('suggestions');
  await expect(block.getByRole('heading', { name: 'Похоже, это уже решали' })).toBeVisible({ timeout: 10_000 });
  // Пока подсказка показана, поля формы свёрнуты (экран 8.3).
  await expect(page.getByRole('radio', { name: 'Ошибка' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Отправить обращение', exact: true })).toBeHidden();
  await block.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/help/a/${number}-[a-z0-9-]+\\?s=[0-9a-f-]{36}$`));
  const session = new URL(page.url()).searchParams.get('s')!;
  expect(await outcomeOf(session)).toEqual({ outcome: 'left', ticket_id: null });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await page.getByRole('button', { name: 'Помогло', exact: true }).click();
  await expect(page.getByText('Спасибо! Рады, что получилось.')).toBeVisible();
  expect((await outcomeOf(session))?.outcome).toBe('helped');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('S1: "Не помогло" возвращает к форме с описанием, обращение создаётся, исход ticket_created', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const word = tag();
  const title = `Заказ ${word} не проводится: нет остатка на складе`;
  await publishSolution(browser, title);
  await typeProblem(page, word);
  const description = await page.getByLabel('Что случилось?').inputValue();
  await page.getByTestId('suggestions').getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/ru\/help\/a\/\d+-[a-z0-9-]+\?s=[0-9a-f-]{36}$/);
  const session = new URL(page.url()).searchParams.get('s')!;
  await page.getByRole('button', { name: 'Не помогло', exact: true }).click();
  await page.getByRole('link', { name: 'Создать обращение' }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/tickets/new\\?s=${session}&open=1$`));
  // Описание сохранено, поля раскрыты сразу (FR-SOL-11).
  await expect(page.getByLabel('Что случилось?')).toHaveValue(description);
  await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Не помогло? Отправьте обращение' })).toBeVisible();
  await page.getByRole('radio', { name: 'Ошибка' }).check();
  await page.getByRole('button', { name: 'Отправить обращение', exact: true }).click();
  await expect(page).toHaveURL(/\/ru\/tickets\/SUP-\d+/);
  const outcome = await outcomeOf(session);
  expect(outcome?.outcome).toBe('ticket_created');
  expect(outcome?.ticket_id).toBeTruthy();
});

test('"Не помогло" в блоке подсказки раскрывает поля, без подсказок поля видны сразу', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const word = tag();
  await publishSolution(browser, `Заказ ${word} зависает: нет остатка на складе`);
  await page.goto('/ru/tickets/new');
  await expect(page.locator('form[data-ready]')).toBeVisible();
  // Слова, которых нет ни в одном решении: база браузерных тестов общая и копит решения других тестов.
  await page.getByLabel('Что случилось?').fill(`${tag()} ${tag()} ${tag()} ${tag()}`);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('suggestions')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Ошибка' })).toBeVisible();
  await page.getByLabel('Что случилось?').fill(`При сохранении заказа ${word} выходит ошибка: нет остатка на складе`);
  await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('radio', { name: 'Ошибка' })).toBeHidden();
  await page.getByRole('button', { name: 'Не помогло, отправить обращение' }).click();
  await expect(page.getByRole('radio', { name: 'Ошибка' })).toBeVisible();
});
