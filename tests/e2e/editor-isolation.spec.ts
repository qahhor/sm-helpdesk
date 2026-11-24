import { expect, test, type Page } from '@playwright/test';
import { sumScriptBytes } from '../../scripts/checks/budget-rules.mjs';
import { CLIENT_STATE } from './helpers/client';

// Редактор решения не попадает в скрипты клиентской части (план M5, решение 1 и задача 1). Проверяется по
// содержимому загруженных скриптов: в коде ProseMirror есть строка класса ProseMirror-hideselection, в Tiptap
// имя расширения "stableIds" из src/ui/doc/editor. Замер скриптов страницы пробы для записи решения 0046.

const EDITOR_MARKERS = ['ProseMirror-hideselection', 'stableIds'];
const AGENT_BUDGET_BYTES = 212 * 1024;

type Script = { url: string; resourceType: string; encodedBytes: number; body: string };

async function scriptsOf(page: Page, path: string, ready: () => Promise<void>): Promise<Script[]> {
  const pending: Promise<Script>[] = [];
  page.on('requestfinished', (request) => {
    if (request.resourceType() !== 'script') return;
    pending.push(
      (async () => {
        const response = await request.response();
        const sizes = await request.sizes();
        return { url: request.url(), resourceType: 'script', encodedBytes: sizes.responseBodySize, body: (await response?.text()) ?? '' };
      })(),
    );
  });
  await page.goto(path, { waitUntil: 'networkidle' });
  await ready();
  return Promise.all(pending);
}
const withEditor = (scripts: Script[]) => scripts.filter((s) => EDITOR_MARKERS.some((marker) => s.body.includes(marker)));
const kb = (bytes: number) => Math.round(bytes / 1024);

test.describe('кабинет клиента', () => {
  test.use({ storageState: CLIENT_STATE });
  for (const [name, path, heading] of [
    ['главная кабинета', '/ru', 'Чем помочь?'],
    ['новое обращение', '/ru/tickets/new', 'Новое обращение'],
  ] as const)
    test(`${name}: в скриптах нет редактора`, async ({ page }, info) => {
      test.skip(info.project.name !== 'phone', 'кабинет клиента проверяется на телефоне');
      const scripts = await scriptsOf(page, path, async () => {
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      });
      expect(scripts.length).toBeGreaterThan(3);
      expect(withEditor(scripts).map((s) => s.url)).toEqual([]);
    });
});

test('открытая страница входа: в скриптах нет редактора', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'кабинет клиента проверяется на телефоне');
  const scripts = await scriptsOf(page, '/ru/login', async () => {
    await expect(page.locator('main h1')).toBeVisible();
  });
  expect(scripts.length).toBeGreaterThan(3);
  expect(withEditor(scripts).map((s) => s.url)).toEqual([]);
});

test('страница пробы: редактор приходит отдельным файлом, замер скриптов', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'рабочее место проверяется на ноутбуке');
  const scripts = await scriptsOf(page, '/ru/dev/editor', async () => {
    await expect(page.locator('.doc-editor')).toBeVisible();
  });
  const editor = withEditor(scripts);
  expect(editor.length).toBeGreaterThan(0);
  const total = sumScriptBytes(scripts);
  const editorBytes = sumScriptBytes(editor);
  const firstScreen = total - editorBytes;
  console.log(`Скрипты страницы пробы: всего ${kb(total)} КБ, из них редактор ${kb(editorBytes)} КБ (${editor.length} файл.), без редактора ${kb(firstScreen)} КБ, бюджет ${kb(AGENT_BUDGET_BYTES)} КБ`);
  // Первый экран без редактора укладывается в бюджет рабочего места: редактор догружается после показа.
  expect(firstScreen).toBeLessThanOrEqual(AGENT_BUDGET_BYTES);
});
