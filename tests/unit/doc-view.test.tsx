import { readFileSync } from 'node:fs';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { parseSolutionDoc, type SolutionDoc } from '@/modules/hdk/doc-schema';
import { DocView, type DocViewLabels } from '@/ui/doc/DocView';
import everyBlock from '../fixtures/doc/every-block.json';

// Отрисовка документа решения на сервере компонентами, без HTML (план M5, задача 1, проверка 5; ТЗ 18.10).
// Строка разметки здесь появляется только в тесте, чтобы проверить итог: сама отрисовка отдаёт дерево React.

const labels: DocViewLabels = { warning: 'Внимание', info: 'Заметка', step: (n) => `Шаг ${n}` };
const doc = parseSolutionDoc(structuredClone(everyBlock));
// Адрес файла решения строит страница: клиенту /help/a/{ref}/files/{id}, сотруднику свой адрес (решение 16).
const imageSrc = (fileId: string) => `/ru/help/a/12-ostatki/files/${fileId}`;
const html = renderToStaticMarkup(<DocView doc={doc} labels={labels} imageSrc={imageSrc} />);

test('каждый вид блока рисуется своим элементом', () => {
  expect(html).toContain('<h2 id="b-h2what00001"');
  expect(html).toContain('<h3 id="b-h3why000001"');
  expect(html).toMatch(/<ul[^>]*data-block="ulwhy000001"/);
  expect(html).toMatch(/<ol[^>]*data-block="olwhy000001"[^>]*start="3"/);
  expect(html).toMatch(/<ol[^>]*data-block="olnested001"/);
  expect(html).toMatch(/<aside[^>]*data-tone="warning"[^>]*>.*Внимание/);
  expect(html).toMatch(/<aside[^>]*data-tone="info"[^>]*>.*Заметка/);
  expect(html).toMatch(/<table[^>]*data-block="table000001"/);
  expect(html).toContain('<th');
  expect(html).toContain('<td');
  expect(html).toContain('<code>ORA-20001</code>');
  expect(html).toContain('<strong>не сбой</strong>');
  expect(html).toContain('<em>проверка остатка</em>');
  expect(html).toContain('<br/>');
});

test('шаги идут нумерованным списком, изображение внутри шага', () => {
  const steps = html.match(/<ol[^>]*data-steps[^>]*>(.*?)<\/ol>/)?.[1] ?? '';
  expect(steps.match(/<li/g)).toHaveLength(2);
  expect(steps).toMatch(/<li[^>]*data-block="step0000001".*<img[^>]*src="\/ru\/help\/a\/12-ostatki\/files\/019ab8c0-0000-7000-8000-000000000001"[^>]*alt="Раздел Остатки"/);
  expect(steps).toContain('Шаг 1');
  expect(steps).toContain('Шаг 2');
});

test('внешняя ссылка открывается без доступа к странице портала, внутренняя как обычная', () => {
  expect(html).toMatch(/<a href="https:\/\/smartup\.uz\/docs" rel="noopener noreferrer nofollow" target="_blank">документации<\/a>/);
  expect(html).toContain('<a href="/help/a/12-ostatki">соседнем решении</a>');
});

test('текст документа выводится как текст: разметка в нём экранируется', () => {
  const hostile: SolutionDoc = parseSolutionDoc({
    version: 1,
    blocks: [{ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }] }],
  });
  const out = renderToStaticMarkup(<DocView doc={hostile} labels={labels} />);
  expect(out).not.toContain('<script');
  expect(out).not.toContain('<img');
  expect(out).toContain('&lt;script&gt;');
});

test('без адреса файла изображение показывается заглушкой с подписью, без img', () => {
  const out = renderToStaticMarkup(<DocView doc={doc} labels={labels} />);
  expect(out).not.toContain('<img');
  expect(out).toMatch(/<div[^>]*data-block="img00000001"[^>]*role="img"[^>]*aria-label="Раздел Остатки"/);
  // Адрес, который страница не смогла построить (файл недоступен), тоже даёт заглушку.
  expect(renderToStaticMarkup(<DocView doc={doc} labels={labels} imageSrc={() => null} />)).not.toContain('<img');
});

/** Обходит дерево элементов, вызывая компоненты-функции, и собирает все свойства. */
function collectProps(node: ReactNode, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((child) => collectProps(child, into));
  else if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    into.push(props);
    if (typeof node.type === 'function') collectProps((node.type as (p: unknown) => ReactNode)(props), into);
    else collectProps(props.children as ReactNode, into);
  }
  return into;
}

test('в дереве отрисовки нет ни одной вставки HTML строкой', () => {
  const props = collectProps(DocView({ doc, labels, imageSrc }));
  expect(props.length).toBeGreaterThan(50);
  for (const p of props) expect(p).not.toHaveProperty('dangerouslySetInnerHTML');
});

test('отрисовка не тянет редактор и не собирает HTML', () => {
  const source = readFileSync('src/ui/doc/DocView.tsx', 'utf8');
  expect(source).not.toMatch(/@tiptap|prosemirror|generateHTML|innerHTML|dangerouslySetInnerHTML|use client/);
});
