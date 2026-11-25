import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dbRows } from './helpers/db';
import { storageStateOf } from './helpers/staff';

// Редактор решения (план M5, задача 3; UX-W-01..05, 10): создание из меню, три блока формы, автосохранение раз в
// 5 секунд, черновик переживает перезагрузку и потерю сети, вторая вкладка получает конфликт, снимок экрана с
// разметкой загружается и проверяется антивирусом, история версий, предпросмотр, доступность. Рабочее место
// проверяется на ноутбуке и в узком окне; телефон пропускается, как у остальных страниц рабочего места.

test.use({ storageState: storageStateOf('l1') });
test.beforeEach(({}, info) => {
  test.skip(info.project.name === 'phone', 'рабочее место проверяется на ноутбуке и в узком окне');
});

const editorArea = (page: Page) => page.locator('.doc-editor');
const saveStatus = (page: Page) => page.getByTestId('save-status');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const resetUploads = () => dbRows(`delete from hdc_rate_limits where code like 'kb-upload-%'`);

/** Новое решение из списка через форму; возвращает номер. */
async function createSolution(page: Page, title: string): Promise<number> {
  await page.goto('/ru/agent/solutions');
  await page.getByRole('link', { name: 'Новое решение' }).click();
  await page.getByLabel('Заголовок').fill(title);
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions\/\d+$/);
  await expect(editorArea(page)).toBeVisible();
  return Number(/solutions\/(\d+)/.exec(page.url())?.[1]);
}

/** Текст в первый абзац блока "Что видит пользователь". */
async function typeWhatUserSees(page: Page, text: string) {
  await editorArea(page).locator(':scope > p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('пункт "Решения" в группе "Знания" открывает список', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'группы меню видны на ширине от 1200');
  await page.goto('/ru/agent');
  await page.getByRole('button', { name: 'Знания' }).click();
  await page.getByRole('menuitem', { name: 'Решения' }).click();
  await expect(page).toHaveURL(/\/ru\/agent\/solutions$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Решения');
});

test('новое решение: три блока формы, автосохранение и текст после перезагрузки', async ({ page }) => {
  const number = await createSolution(page, `Остаток не списывается ${Date.now()}`);
  await expect(editorArea(page).locator('h2')).toHaveText(['Что видит пользователь', 'Почему так происходит', 'Что сделать']);
  await expect(editorArea(page).locator('.node-step')).toHaveCount(1);
  await typeWhatUserSees(page, 'Ошибка при проведении накладной');
  await expect(saveStatus(page)).toHaveText(/Есть несохранённые изменения|Сохраняем/);
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.reload();
  await expect(editorArea(page)).toContainText('Ошибка при проведении накладной');
  const [row] = await dbRows<{ doc: unknown }>(`select v.doc from hdk_article_versions v join hdk_articles a using (article_id) where a.number = $1 and v.state = 'draft'`, [number]);
  expect(JSON.stringify(row?.doc)).toContain('Ошибка при проведении накладной');
  // Список: решение в "Моих задачах" и в общем списке с фильтром "Черновик".
  await page.goto('/ru/agent/solutions');
  await expect(page.getByTestId('solutions-mine').locator(`[data-solution="${number}"]`)).toBeVisible();
  await page.getByLabel('Статус').selectOption('draft');
  await page.getByRole('button', { name: 'Показать' }).click();
  await expect(page.getByTestId('solutions-all').locator(`[data-solution="${number}"]`)).toBeVisible();
  expect(await fits(page)).toBe(true);
});

test('нет сети: правки копятся, строка состояния это говорит, после возврата связи сохраняются', async ({ page, context }) => {
  const number = await createSolution(page, `Без сети ${Date.now()}`);
  await context.setOffline(true);
  await typeWhatUserSees(page, 'Написано без связи');
  await expect(saveStatus(page)).toHaveText('Нет связи. Изменения сохранятся, когда связь вернётся.', { timeout: 15_000 });
  await context.setOffline(false);
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.reload();
  await expect(editorArea(page)).toContainText('Написано без связи');
  expect(number).toBeGreaterThan(0);
});

test('перезагрузка до автосохранения: текст восстанавливается из браузера и сохраняется', async ({ page }) => {
  await createSolution(page, `Перезагрузка ${Date.now()}`);
  // Сохранение не доходит до сервера (запросы действий обрываются), затем страница перезагружается.
  const drop = (route: import('@playwright/test').Route) => (route.request().method() === 'POST' ? route.abort() : route.continue());
  await page.route('**/agent/solutions/**', drop);
  await typeWhatUserSees(page, 'Не успело сохраниться');
  await expect(saveStatus(page)).toHaveText('Нет связи. Изменения сохранятся, когда связь вернётся.', { timeout: 15_000 });
  await page.unroute('**/agent/solutions/**', drop);
  await page.reload();
  await expect(page.getByText('Восстановлен текст, который не успел сохраниться.')).toBeVisible();
  await expect(editorArea(page)).toContainText('Не успело сохраниться');
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.reload();
  await expect(editorArea(page)).toContainText('Не успело сохраниться');
  await expect(page.getByText('Восстановлен текст, который не успел сохраниться.')).toHaveCount(0);
});

test('копия в браузере от другой версии черновика не удаляется: её можно показать, скопировать и отбросить (0057, I4c)', async ({ page, context }) => {
  const number = await createSolution(page, `Чужая версия ${Date.now()}`);
  await typeWhatUserSees(page, 'Текст на сервере');
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  // Копия, сделанная от прежней версии строки (черновик с тех пор сохранили из другой вкладки).
  const key = `hub:solution-draft:${number}:ru`;
  await page.evaluate((k) => {
    const doc = { version: 1, blocks: [{ type: 'paragraph', attrs: { id: 'staleblock01' }, content: [{ type: 'text', text: 'Текст из другой версии' }] }] };
    localStorage.setItem(k, JSON.stringify({ versionId: '00000000-0000-7000-8000-000000000000', revision: 'old', title: 'Старая правка', doc }));
  }, key);
  await page.reload();
  const stale = page.getByTestId('stale-backup');
  await expect(stale).toContainText('Есть несохранённый текст от другой версии черновика');
  await expect(editorArea(page)).not.toContainText('Текст из другой версии');
  await stale.getByRole('button', { name: 'Показать' }).click();
  await expect(page.getByTestId('stale-backup-text')).toContainText('Старая правка');
  await expect(page.getByTestId('stale-backup-text')).toContainText('Текст из другой версии');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stale.getByRole('button', { name: 'Скопировать' }).click();
  await expect(stale.getByRole('button', { name: 'Скопировано' })).toBeVisible();
  // Правка текущего черновика копию не затирает: после перезагрузки она на месте.
  await typeWhatUserSees(page, ' и правка');
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId('stale-backup')).toBeVisible();
  await page.getByTestId('stale-backup').getByRole('button', { name: 'Отбросить' }).click();
  await expect(page.getByTestId('stale-backup')).toHaveCount(0);
  await page.reload();
  await expect(editorArea(page)).toContainText('Текст на сервере и правка');
  await expect(page.getByTestId('stale-backup')).toHaveCount(0);
});

test('две вкладки: вторая получает конфликт, её текст остаётся на странице, первая не затёрта', async ({ page, context }) => {
  const number = await createSolution(page, `Две вкладки ${Date.now()}`);
  const second = await context.newPage();
  await second.goto(`/ru/agent/solutions/${number}`);
  await expect(editorArea(second)).toBeVisible();
  await typeWhatUserSees(page, 'Первая вкладка');
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await typeWhatUserSees(second, 'Вторая вкладка');
  await expect(second.getByTestId('solution-workspace').getByRole('alert')).toContainText('Черновик изменили в другой вкладке', { timeout: 15_000 });
  await expect(editorArea(second)).toContainText('Вторая вкладка');
  const [row] = await dbRows<{ doc: unknown }>(`select v.doc from hdk_article_versions v join hdk_articles a using (article_id) where a.number = $1 and v.state = 'draft'`, [number]);
  expect(JSON.stringify(row?.doc)).toContain('Первая вкладка');
  expect(JSON.stringify(row?.doc)).not.toContain('Вторая вкладка');
  await second.close();
});

test('снимок экрана: файл, разметка стрелкой и номером, проверка антивирусом, изображение в шаге', async ({ page }) => {
  await resetUploads();
  const number = await createSolution(page, `Снимок ${Date.now()}`);
  await editorArea(page).locator('.node-step p').first().click();
  await page.keyboard.type('Откройте раздел Склад');
  await page.getByRole('toolbar', { name: 'Оформление текста' }).getByRole('button', { name: 'Изображение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Снимок экрана' });
  await expect(dialog).toBeVisible();
  // Снимок 64x48: PNG, нарисованный в браузере.
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillRect(0, 0, 320, 240);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  const canvas = dialog.getByRole('img', { name: 'Снимок экрана с разметкой' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await dialog.getByRole('button', { name: 'Номер шага' }).click();
  await canvas.click({ position: { x: box.width - 30, y: 30 } });
  await expect(canvas).toHaveAttribute('data-shapes', '2');
  await dialog.getByLabel('Что на снимке').fill('Раздел Склад');
  await dialog.getByRole('button', { name: 'Вставить' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const image = editorArea(page).locator('.node-step img[data-file-id]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  const [file] = await dbRows<{ scan_status: string; storage_key: string }>(
    `select f.scan_status, f.storage_key from hdk_article_files f join hdk_articles a using (article_id) where a.number = $1`,
    [number],
  );
  expect(file?.scan_status).toBe('clean');
  expect(file?.storage_key).toMatch(/^files\/kb\//);
  // Файл отдаётся с типом от портала и запретом угадывать тип.
  const src = await image.getAttribute('src');
  const response = await page.request.get(src!);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['content-type']).toBe('image/png');
});

test('история версий, предпросмотр на телефоне и компьютере, доступность редактора и списка', async ({ page }) => {
  const number = await createSolution(page, `Версии ${Date.now()}`);
  await typeWhatUserSees(page, 'Текст для предпросмотра');
  await expect(saveStatus(page)).toHaveText(/Сохранено в/, { timeout: 15_000 });
  await expect(page.getByTestId('solution-versions').locator('[data-version="1"]')).toContainText('Черновик');
  let axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  expect(await fits(page)).toBe(true);

  await page.getByRole('link', { name: 'Предпросмотр' }).click();
  await expect(page).toHaveURL(new RegExp(`/ru/agent/solutions/${number}/preview$`));
  const preview = page.getByTestId('solution-preview');
  await expect(preview).toHaveAttribute('data-device', 'phone');
  await expect(preview).toContainText('Текст для предпросмотра');
  expect((await preview.boundingBox())!.width).toBeLessThanOrEqual(360);
  await page.getByRole('link', { name: 'Компьютер' }).click();
  await expect(preview).toHaveAttribute('data-device', 'desktop');
  expect((await preview.boundingBox())!.width).toBeGreaterThan(360);
  axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  await page.goto('/ru/agent/solutions');
  axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  expect(await fits(page)).toBe(true);
});
