import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { CLIENT_STATE } from './helpers/client';
import { dbRows } from './helpers/db';
import { signInStaff, staffAccount, storageStateOf } from './helpers/staff';

// Проверка, публикация, архив и страница решения клиента (план M5, задача 4; FR-SOL-04, 05, 17, UX-W-07, ТЗ 8.3).
// Вторая линия видит находки и панель готовности, публикует с подтверждением находок; первая линия публиковать не
// может; клиент читает только опубликованное, отвечает "Помогло", архивное решение показывает "больше не действует".
// Текст с разметкой из буфера на странице клиента остаётся текстом. Страница клиента проверяется на телефоне и
// ноутбуке, рабочее место на ноутбуке.

const MODULE_CODE = 'e2e-kb-warehouse';
const editorArea = (page: Page) => page.locator('.doc-editor');
const saveStatus = (page: Page) => page.getByTestId('save-status');
/** Метка теста без длинных чисел: Date.now() в заголовке стал бы находкой "длинное число". */
const tag = () => Math.random().toString(36).slice(2, 8);
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function ensureModule(): Promise<void> {
  await dbRows(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Склад (решения)", "uz": "Ombor (yechimlar)", "en": "Warehouse (solutions)"}') on conflict (code) do nothing`, [MODULE_CODE]);
}

/** Решение вводом в редакторе от имени сотрудника; возвращает номер. Публикует, если publish. */
async function writeSolution(browser: Browser, opts: { title: string; what: string; step: string; publish: boolean; confirm?: boolean }): Promise<number> {
  await ensureModule();
  const context = await browser.newContext({ storageState: storageStateOf('l2') });
  const page = await context.newPage();
  await page.goto('/ru/agent/solutions/new');
  await page.getByLabel('Заголовок').fill(opts.title);
  await page.getByLabel('Модуль').selectOption({ label: 'Склад (решения)' });
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
  const number = Number(/solutions\/(\d+)/.exec(page.url())?.[1]);
  await editorArea(page).locator(':scope > p').first().click();
  await page.keyboard.type(opts.what);
  await editorArea(page).locator('.node-step p').first().click();
  await page.keyboard.type(opts.step);
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  if (opts.publish) {
    const review = page.getByTestId('solution-review');
    if (opts.confirm) await review.getByLabel(/Я проверил находки/).check();
    await review.getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
  }
  await context.close();
  return number;
}

test.describe('рабочее место', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  });

  test('вторая линия: находки подсвечены, публикация только с подтверждением, копия в базе, первая линия не публикует', async ({ browser }) => {
    await ensureModule();
    const context = await browser.newContext({ storageState: storageStateOf('l2') });
    const l2 = await context.newPage();
    await l2.goto('/ru/agent/solutions/new');
    await l2.getByLabel('Заголовок').fill(`Остаток не списывается ${tag()}`);
    await l2.getByRole('button', { name: 'Создать' }).click();
    await expect(editorArea(l2)).toBeVisible();
    const number = Number(/solutions\/(\d+)/.exec(l2.url())?.[1]);
    const review = l2.getByTestId('solution-review');
    // Без модуля и без текста шага публиковать нельзя.
    await expect(review.locator('[data-item="module"]')).toHaveAttribute('data-ok', 'no');
    await expect(review.locator('[data-item="steps"]')).toHaveAttribute('data-ok', 'no');
    await expect(review.getByRole('button', { name: 'Опубликовать' })).toBeDisabled();
    await l2.getByLabel('Модуль').selectOption({ label: 'Склад (решения)' });
    await expect(review.locator('[data-item="module"]')).toHaveAttribute('data-ok', 'yes');
    await editorArea(l2).locator(':scope > p').first().click();
    await l2.keyboard.type('Позвоните +998 90 123 45 67');
    await editorArea(l2).locator('.node-step p').first().click();
    await l2.keyboard.type('Откройте раздел Склад');
    await expect(saveStatus(l2)).toHaveText(/Сохранено в/, { timeout: 15_000 });
    // Находка: телефон назван текстом, блок обведён.
    await expect(l2.getByTestId('solution-findings').locator('[data-kind="phone"]')).toContainText('+998 90 123 45 67');
    await expect(editorArea(l2).locator('.doc-finding')).toHaveCount(1);
    const publish = review.getByRole('button', { name: 'Опубликовать' });
    await expect(publish).toBeDisabled();
    await review.getByLabel(/Я проверил находки/).check();
    const axe = await new AxeBuilder({ page: l2 }).analyze();
    expect(axe.violations).toEqual([]);
    await publish.click();
    await expect(l2.getByText('Решение опубликовано.')).toBeVisible({ timeout: 15_000 });
    await expect(l2.getByTestId('solution-labels')).toContainText('Опубликовано');
    const [copy] = await dbRows<{ title: string; audience: string }>(`select title, audience from hdk_published where article_number = $1`, [number]);
    expect(copy?.audience).toBe('clients');
    await context.close();

    // Первая линия: решение открыто, кнопок публикации и архива нет.
    const l1 = await browser.newContext({ storageState: storageStateOf('l1') });
    const l1page = await l1.newPage();
    await l1page.goto(`/ru/agent/solutions/${number}`);
    await expect(editorArea(l1page)).toBeVisible();
    await expect(l1page.getByTestId('solution-review')).toBeVisible();
    await expect(l1page.getByRole('button', { name: 'Опубликовать' })).toHaveCount(0);
    await expect(l1page.getByTestId('solution-archive')).toHaveCount(0);
    await l1.close();
  });

  test('ссылка вне списка разрешённых доменов не публикуется даже с подтверждением', async ({ browser }) => {
    await ensureModule();
    const context = await browser.newContext({ storageState: storageStateOf('l2') });
    const page = await context.newPage();
    await page.goto('/ru/agent/solutions/new');
    await page.getByLabel('Заголовок').fill(`Со ссылкой ${tag()}`);
    await page.getByLabel('Модуль').selectOption({ label: 'Склад (решения)' });
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(editorArea(page)).toBeVisible();
    await editorArea(page).locator('.node-step p').first().click();
    await page.keyboard.type('Скачайте файл с http://files.evil.example/tool.exe');
    await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
    const review = page.getByTestId('solution-review');
    await expect(page.getByTestId('solution-findings').locator('[data-kind="link"]')).toContainText('files.evil.example');
    await expect(review).toHaveAttribute('data-ready', 'no');
    await expect(review.getByLabel(/Я проверил находки/)).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Опубликовать' })).toBeDisabled();
    await context.close();
  });

  test('администратор задаёт разрешённые домены; адрес приводится к домену, мусор называется', async ({ page }) => {
    await signInStaff(page, staffAccount('admin'));
    await page.goto('/ru/agent/settings');
    await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('link', { name: 'Решения' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Решения');
    await page.getByLabel('Разрешённые домены').fill('https://Docs.Smartup.uz/stock\nsmartup.uz');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Список доменов сохранён.')).toBeVisible();
    await expect(page.getByLabel('Разрешённые домены')).toHaveValue('docs.smartup.uz\nsmartup.uz');
    await page.getByLabel('Разрешённые домены').fill('smartup.uz 10.0.0.1');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Это не домен' })).toContainText('Это не домен: 10.0.0.1');
    await expect(page.getByLabel('Разрешённые домены')).toHaveValue('docs.smartup.uz\nsmartup.uz');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });
});

test.describe('клиент', () => {
  test.use({ storageState: CLIENT_STATE });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === 'narrow', 'страница клиента проверяется на телефоне и ноутбуке');
  });

  test('опубликованное решение: текст, модуль, "Помогло"; текст с разметкой остаётся текстом', async ({ page, browser }) => {
    const hostile = '<img src=x onerror="window.__xss=1"> и <b>жирный</b>';
    const number = await writeSolution(browser, { title: `Отчёт не открывается ${tag()}`, what: hostile, step: 'Откройте раздел Отчёты', publish: true });
    await dbRows(`delete from hdc_rate_limits where code like 'kb-feedback%'`);
    await page.goto(`/ru/help/a/${number}`);
    // Адрес без slug ведёт на адрес со slug.
    await expect(page).toHaveURL(new RegExp(`/ru/help/a/${number}-otchyot-ne-otkryvaetsya`));
    const article = page.getByTestId('solution-page');
    await expect(article.getByRole('heading', { level: 1 })).toContainText('Отчёт не открывается');
    await expect(article).toContainText('Модуль: Склад (решения)');
    await expect(article).toContainText(hostile);
    await expect(article.locator('img')).toHaveCount(0);
    await expect(article.locator('b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(article.locator('ol[data-steps] > li')).toContainText('Откройте раздел Отчёты');
    expect(await fits(page)).toBe(true);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
    await page.getByRole('button', { name: 'Помогло', exact: true }).click();
    await expect(page.getByText('Спасибо! Рады, что получилось.')).toBeVisible();
    const [row] = await dbRows<{ helped_count: number }>(`select helped_count from hdk_articles where number = $1`, [number]);
    expect(row?.helped_count).toBe(1);
  });

  test('черновик и внутреннее решение клиенту не видны; архивное показывает "больше не действует"', async ({ page, browser }) => {
    const draft = await writeSolution(browser, { title: `Только черновик ${tag()}`, what: 'Черновой текст', step: 'Черновой шаг', publish: false });
    await page.goto(`/ru/help/a/${draft}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
    await expect(page.getByText('Черновой текст')).toHaveCount(0);
    const published = await writeSolution(browser, { title: `Снимем в архив ${tag()}`, what: 'Текст для архива', step: 'Шаг для архива', publish: true });
    await page.goto(`/ru/help/a/${published}`);
    await expect(page.getByTestId('solution-page')).toContainText('Текст для архива');
    // Архив делает вторая линия на странице решения.
    const context = await browser.newContext({ storageState: storageStateOf('l2') });
    const agent = await context.newPage();
    await agent.goto(`/ru/agent/solutions/${published}`);
    const form = agent.getByTestId('solution-archive');
    await form.getByLabel('Да, снять с портала').check();
    await form.getByRole('button', { name: 'Снять в архив' }).click();
    await expect(agent.getByText('Решение снято в архив.')).toBeVisible();
    await context.close();
    await page.goto(`/ru/help/a/${published}`);
    await expect(page.getByTestId('solution-archived')).toContainText('Решение больше не действует');
    await expect(page.getByText('Текст для архива')).toHaveCount(0);
    await page.getByRole('link', { name: 'Создать обращение' }).click();
    await expect(page).toHaveURL(/\/ru\/tickets\/new/);
  });
});
