import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { collectBlockIds, parseSolutionDoc, type SolutionDoc } from '../../src/modules/hdk/doc-schema';
import { fromEditorJson } from '../../src/ui/doc/editor/convert';

// Проба редактора решений (план M5, задача 1; ТЗ 18.4): пять проверок в настоящем браузере на странице
// /ru/dev/editor (открыта при HUB_SHOWCASE=1). Каждый итог редактора проверяется схемой документа.
// Снимки экрана для записи решения кладутся в test-results/editor-trial.

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'редактор решений работает на ноутбуке сотрудника');
});

type Json = Parameters<typeof fromEditorJson>[0];

async function open(page: Page, path = '/ru/dev/editor') {
  await page.goto(path);
  await expect(page.locator('.doc-editor')).toBeVisible();
  await page.waitForFunction(() => Boolean((window as unknown as { __solutionEditor?: unknown }).__solutionEditor));
}
async function savedDoc(page: Page): Promise<SolutionDoc> {
  const json = await page.evaluate(() => (window as unknown as { __solutionEditor: { getJSON(): unknown } }).__solutionEditor.getJSON());
  return parseSolutionDoc(fromEditorJson(json as Json));
}
const topIds = (doc: SolutionDoc) => doc.blocks.map((b) => b.attrs.id);
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/editor-trial/${name}.png`, fullPage: true });

async function paste(page: Page, html: string) {
  await page.evaluate((data) => {
    const target = document.querySelector('.doc-editor')!;
    const transfer = new DataTransfer();
    transfer.setData('text/html', data);
    transfer.setData('text/plain', data.replace(/<[^>]+>/g, ' '));
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, html);
}
async function clear(page: Page) {
  await page.evaluate(() => (window as unknown as { __solutionEditor: { commands: { clearContent(): void; focus(): void } } }).__solutionEditor.commands.clearContent());
  await page.locator('.doc-editor').click();
}
const fixture = (name: string) => readFileSync(`tests/fixtures/paste/${name}`, 'utf8');
/** Весь текст блока, включая вложенные. */
const textOf = (node: unknown): string =>
  node && typeof node === 'object'
    ? ((node as { text?: string }).text ?? '') + ((node as { content?: unknown[] }).content ?? []).map(textOf).join(node && (node as { type?: string }).type === 'listItem' ? ' ' : '')
    : '';

test('1. шаг с изображением: изображение встаёт внутрь шага', async ({ page }) => {
  // Редактор не нарушает политику CSP: стили ProseMirror подключены файлом (нарушение Chromium пишет ошибкой в консоль).
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await open(page);
  await page.locator('.node-step').nth(1).getByText(/Проверьте остаток/).click();
  await page.keyboard.press('End');
  await page.getByRole('toolbar').getByRole('button', { name: 'Изображение' }).click();
  const doc = await savedDoc(page);
  const step = doc.blocks.find((b) => b.attrs.id === 'samplestep02');
  expect(step?.type).toBe('step');
  expect(step?.type === 'step' && step.content.map((c) => c.type)).toEqual(['paragraph', 'image']);
  await expect(page.locator('.node-step').nth(1).locator('img')).toBeVisible();
  expect(problems).toEqual([]);
  await shot(page, '1-step-image');
});

test('2. перетаскивание шагов мышью и перенос с клавиатуры сохраняют идентификаторы', async ({ page }) => {
  await open(page);
  const before = await savedDoc(page);
  const steps = page.locator('.node-step');
  await expect(steps.nth(1)).toHaveAttribute('data-step-number', '2');
  // Мышь: второй шаг за ручку на место первого.
  await steps.nth(1).locator('[data-drag-handle]').dragTo(steps.nth(0), { targetPosition: { x: 60, y: 4 } });
  let doc = await savedDoc(page);
  let ids = topIds(doc);
  expect(ids.indexOf('samplestep02')).toBeLessThan(ids.indexOf('samplestep01'));
  expect(collectBlockIds(doc).sort()).toEqual(collectBlockIds(before).sort());
  await expect(steps.nth(0)).toHaveAttribute('data-step-number', '1');
  await expect(steps.nth(0)).toContainText('Проверьте остаток');
  await shot(page, '2-drag');
  // Клавиатура: курсор в первом шаге, Alt+Shift+стрелка вниз возвращает порядок.
  await steps.nth(0).getByText(/Проверьте остаток/).click();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  doc = await savedDoc(page);
  ids = topIds(doc);
  expect(ids.indexOf('samplestep01')).toBeLessThan(ids.indexOf('samplestep02'));
  // Кнопка панели делает то же.
  await page.getByRole('toolbar').getByRole('button', { name: /Переместить выше/ }).click();
  doc = await savedDoc(page);
  ids = topIds(doc);
  expect(ids.indexOf('samplestep02')).toBeLessThan(ids.indexOf('samplestep01'));
  expect(collectBlockIds(doc).sort()).toEqual(collectBlockIds(before).sort());
});

test('3а. вставка из Word: таблица остаётся таблицей, стили и служебная разметка уходят', async ({ page }) => {
  await open(page);
  await clear(page);
  await paste(page, fixture('word-table.html'));
  const doc = await savedDoc(page);
  expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'table']);
  expect(textOf(doc.blocks[0])).toBe('Коды ошибок проведения');
  const table = doc.blocks[2]!;
  if (table.type !== 'table') throw new Error('нет таблицы');
  expect(table.content).toHaveLength(3);
  expect(table.content[0]!.content.map(textOf)).toEqual(['Код', 'Что сделать']);
  expect(table.content[2]!.content[0]!.attrs.colspan).toBe(2);
  const raw = JSON.stringify(doc);
  expect(raw).toContain('"type":"bold"');
  for (const junk of ['mso', 'o:p', 'style', 'class', 'color', 'Calibri', ' ']) expect(raw).not.toContain(junk);
  await shot(page, '3a-word-table');
});

test('3б. вставка из Word: нумерованный и маркированный списки становятся списками', async ({ page }) => {
  await open(page);
  await clear(page);
  await paste(page, fixture('word-numbered-list.html'));
  const doc = await savedDoc(page);
  expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'orderedList', 'paragraph', 'bulletList']);
  const ordered = doc.blocks[1]!;
  if (ordered.type !== 'orderedList') throw new Error('нет списка');
  expect(ordered.content).toHaveLength(3);
  expect(textOf(ordered.content[0]!.content[0])).toBe('Откройте раздел Склад');
  // Второй уровень Word (a.) вложен во второй пункт.
  expect(ordered.content[1]!.content[1]?.type).toBe('orderedList');
  expect(textOf(ordered.content[1]!.content[1])).toBe('номер есть в письме');
  const bullets = doc.blocks[3]!;
  expect(bullets.type === 'bulletList' && bullets.content.map((item) => textOf(item.content[0]))).toEqual(['права на склад', 'открытый период']);
  // Номера Word ("1.", "·") не остались в тексте.
  expect(JSON.stringify(doc)).not.toMatch(/"text":"(?:\d\.|·|a\.)/);
  await shot(page, '3b-word-lists');
});

test('3в. вставка из Word: заголовки по уровням, ссылки и изображения вне списка не проходят', async ({ page }) => {
  await open(page);
  await clear(page);
  await paste(page, fixture('word-mixed.html'));
  const doc = await savedDoc(page);
  expect(doc.blocks.map((b) => (b.type === 'heading' ? `h${b.attrs.level}` : b.type))).toEqual(['h2', 'h2', 'paragraph', 'h3', 'paragraph', 'paragraph']);
  expect(textOf(doc.blocks[0])).toBe('Остатки не сходятся');
  const raw = JSON.stringify(doc);
  expect(raw).toContain('"href":"https://smartup.uz/docs/stock"');
  for (const bad of ['http://old', 'javascript:', 'file:', 'alert', '"image"', 'underline', 'strike', 'onclick']) expect(raw).not.toContain(bad);
  // Текст ссылок, которые не прошли, остаётся текстом.
  expect(textOf(doc.blocks[4])).toContain('архив');
  expect(textOf(doc.blocks[2])).toContain('Подчёркнутый');
  await shot(page, '3c-word-mixed');
});

test('4. копия блока внутри документа получает новые идентификаторы, оригинал свои сохраняет', async ({ page }) => {
  await open(page);
  const before = await savedDoc(page);
  // Копирование шага через буфер ProseMirror: событие copy с выделенным узлом, затем paste в конец документа.
  const html = await page.evaluate(() => {
    const editor = (window as unknown as { __solutionEditor: { state: { doc: { forEach(f: (n: { attrs: { id: string } }, o: number) => void): void } }; commands: { setNodeSelection(p: number): void } } }).__solutionEditor;
    let pos = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.attrs.id === 'samplestep01') pos = offset;
    });
    editor.commands.setNodeSelection(pos);
    const transfer = new DataTransfer();
    document.querySelector('.doc-editor')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return transfer.getData('text/html');
  });
  expect(html).toContain('data-id="samplestep01"');
  await page.evaluate(() => (window as unknown as { __solutionEditor: { commands: { focus(p: string): void } } }).__solutionEditor.commands.focus('end'));
  await paste(page, html);
  const doc = await savedDoc(page);
  const ids = collectBlockIds(doc);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of collectBlockIds(before)) expect(ids).toContain(id);
  expect(doc.blocks.filter((b) => b.type === 'step')).toHaveLength(3);
  expect(topIds(doc).indexOf('samplestep01')).toBe(topIds(before).indexOf('samplestep01'));
});

test('5. сохранение и загрузка: сервер проверяет документ схемой и рисует его компонентами', async ({ page }) => {
  await open(page);
  await page.locator('.doc-editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Текст после правки <b>не разметка</b>.');
  const before = await savedDoc(page);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/\?doc=/);
  await expect(page.getByRole('status')).toContainText('Документ сохранён');
  const preview = page.getByTestId('doc-preview');
  // Разметка из текста показана как текст, а не как элемент.
  await expect(preview).toContainText('Текст после правки <b>не разметка</b>.');
  await expect(preview.locator('b')).toHaveCount(0);
  await expect(preview.locator('ol[data-steps] > li')).toHaveCount(2);
  await expect(preview.locator('aside[data-tone="warning"]')).toBeVisible();
  await expect(preview.locator('table th')).toHaveCount(2);
  await expect(preview.locator('li img')).toBeVisible();
  await open(page, page.url());
  expect(collectBlockIds(await savedDoc(page))).toEqual(collectBlockIds(before));
  await shot(page, '5-saved');
});

test('документ, не прошедший схему, не показывается', async ({ page }) => {
  const bad = Buffer.from(JSON.stringify({ version: 1, blocks: [{ type: 'script', attrs: { id: 'script00001' } }] })).toString('base64url');
  await open(page, `/ru/dev/editor?doc=${bad}`);
  await expect(page.getByRole('alert').filter({ hasText: 'не прошёл проверку' })).toBeVisible();
});

test('панель инструментов: подписи, клавиатура, без нарушений доступности', async ({ page }) => {
  await open(page);
  const toolbar = page.getByRole('toolbar', { name: 'Оформление текста' });
  const buttons = toolbar.getByRole('button');
  expect(await buttons.count()).toBeGreaterThanOrEqual(20);
  for (const label of await buttons.evaluateAll((list) => list.map((b) => b.getAttribute('aria-label')))) expect(label).toBeTruthy();
  // Одна остановка Tab, дальше стрелки.
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await page.locator('.doc-editor p').first().dblclick();
  await buttons.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Курсив');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
  expect(JSON.stringify(await savedDoc(page))).toContain('"type":"bold"');
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
