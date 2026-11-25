import { describe, expect, test } from 'vitest';
import { BLOCK_TYPES, collectImageFileIds, MAX_BLOCKS, parseSolutionDoc, safeParseSolutionDoc } from '@/modules/hdk/doc-schema';
import everyBlock from '../fixtures/doc/every-block.json';

// Документ решения (план M5, решение 1 и задача 2; ТЗ 18.10): закрытый список блоков этапа 1, у каждого
// блока устойчивый идентификатор, ссылки только https и внутренние (план M5, задача 2), изображение это ссылка на
// строку hdk_article_files (решение 16), а не адрес.

const clone = <T>(value: T): T => structuredClone(value);
const p = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const doc = (...blocks: unknown[]) => ({ version: 1, blocks });
const rejected = (value: unknown) => expect(safeParseSolutionDoc(value).success).toBe(false);
const FILE = '019ab8c0-0000-7000-8000-0000000000aa';
const img = (id: string, attrs: Record<string, unknown> = {}) => ({ type: 'image', attrs: { id, fileId: FILE, alt: '', ...attrs } });

test('закрытый список блоков этапа 1 совпадает с планом M5 (задача 2)', () => {
  expect([...BLOCK_TYPES].sort()).toEqual(['bulletList', 'callout', 'heading', 'image', 'orderedList', 'paragraph', 'step', 'table'].sort());
});

test('документ со всеми видами блоков проходит схему без изменений', () => {
  expect(parseSolutionDoc(clone(everyBlock))).toEqual(everyBlock);
});

test('пустой документ допустим', () => {
  expect(parseSolutionDoc(doc())).toEqual(doc());
});

test('шаг с изображением: изображение внутри шага после текста', () => {
  const step = { type: 'step', attrs: { id: 'step0000009' }, content: [p('pstep000009', 'Нажмите'), img('img00000009', { alt: 'Кнопка' })] };
  expect(parseSolutionDoc(doc(step)).blocks[0]).toEqual(step);
});

test('шаг начинается с текста, изображение первым не встаёт', () => {
  rejected(doc({ type: 'step', attrs: { id: 'step0000009' }, content: [img('img00000009')] }));
});

describe('отклоняется', () => {
  test('неизвестный блок', () => rejected(doc({ type: 'codeBlock', attrs: { id: 'code0000001' }, content: [{ type: 'text', text: 'x' }] })));
  test('блок без идентификатора', () => rejected(doc({ type: 'paragraph', content: [{ type: 'text', text: 'x' }] })));
  test('короткий идентификатор', () => rejected(doc(p('abc', 'x'))));
  test('повтор идентификатора в документе', () => {
    rejected(doc(p('same0000001', 'a'), { type: 'callout', attrs: { id: 'callout0001', tone: 'info' }, content: [p('same0000001', 'b')] }));
  });
  test('заголовок первого уровня', () => rejected(doc({ type: 'heading', attrs: { id: 'h1000000001', level: 1 }, content: [{ type: 'text', text: 'x' }] })));
  test('неизвестная отметка текста', () => rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' }] }] })));
  test('лишний атрибут блока (стиль)', () => rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001', style: 'color:red' } })));
  test('лишнее поле узла', () => rejected(doc({ ...p('p0000000001', 'x'), html: '<b>x</b>' })));
  test('скрипт как блок', () => rejected(doc({ type: 'script', attrs: { id: 'script00001' }, content: [{ type: 'text', text: 'alert(1)' }] })));
  test.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'http://smartup.uz', '//evil.example/x', '/\\evil.example', 'data:text/html,<script>', 'vbscript:x', 'https://', 'mailto:', 'mailto:help@smartup.uz', 'ftp://smartup.uz/x', 'https://user:pass@smartup.uz/'])(
    'ссылка %s',
    (href) => rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] })),
  );
  // Изображение несёт только ссылку на файл решения: адрес (свой или чужой) в документ не попадает никогда.
  test.each(['https://evil.example/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/ru/dev/editor/sample-image', 'file:///C:/a.png'])('изображение с адресом %s', (src) =>
    rejected(doc({ type: 'image', attrs: { id: 'img00000001', src, alt: '' } })),
  );
  test('изображение с адресом рядом со ссылкой на файл', () => rejected(doc(img('img00000001', { src: '/ru/x.png' }))));
  test.each([['без ссылки на файл', undefined], ['ссылка не uuid', '12'], ['ссылка с путём', '../019ab8c0-0000-7000-8000-0000000000aa'], ['пустая ссылка', '']])(
    'изображение %s',
    (_, fileId) => rejected(doc({ type: 'image', attrs: { id: 'img00000001', alt: '', ...(fileId === undefined ? {} : { fileId }) } })),
  );
  test('подпись изображения длиннее 300 знаков', () => rejected(doc(img('img00000001', { alt: 'x'.repeat(301) }))));
  test('скрипт в тексте не страшен, а узел с HTML отклоняется', () => {
    rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'html', html: '<script>alert(1)</script>' }] }));
  });
  test('таблица без строк', () => rejected(doc({ type: 'table', attrs: { id: 'table000001' }, content: [] })));
  test('ячейка таблицы со списком внутри', () => {
    const list = { type: 'bulletList', attrs: { id: 'ul000000001' }, content: [{ type: 'listItem', content: [p('p0000000002', 'x')] }] };
    rejected(doc({ type: 'table', attrs: { id: 'table000001' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [list] }] }] }));
  });
  test('предупреждение неизвестного вида', () => rejected(doc({ type: 'callout', attrs: { id: 'callout0001', tone: 'danger' }, content: [p('p0000000001', 'x')] })));
  test('пустой текстовый узел', () => rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: '' }] })));
  test(`больше ${MAX_BLOCKS} блоков`, () => rejected(doc(...Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => p(`p${String(i).padStart(10, '0')}`, 'x')))));
  test('другая версия документа', () => rejected({ version: 2, blocks: [] }));
});

// Неизвестный атрибут отклоняется у каждого вида блока: атрибуты проверяются по виду блока.
const withExtra: [string, Record<string, unknown>][] = [
  ['heading', { type: 'heading', attrs: { id: 'h0000000001', level: 2, onclick: 'x' }, content: [{ type: 'text', text: 'x' }] }],
  ['paragraph', { type: 'paragraph', attrs: { id: 'p0000000001', class: 'x' } }],
  ['bulletList', { type: 'bulletList', attrs: { id: 'ul000000001', style: 'x' }, content: [{ type: 'listItem', content: [p('p0000000002', 'x')] }] }],
  ['orderedList', { type: 'orderedList', attrs: { id: 'ol000000001', start: 1, type: 'a' }, content: [{ type: 'listItem', content: [p('p0000000002', 'x')] }] }],
  ['listItem', { type: 'bulletList', attrs: { id: 'ul000000001' }, content: [{ type: 'listItem', attrs: { checked: true }, content: [p('p0000000002', 'x')] }] }],
  ['step', { type: 'step', attrs: { id: 'step0000001', number: 3 }, content: [p('p0000000002', 'x')] }],
  ['callout', { type: 'callout', attrs: { id: 'callout0001', tone: 'info', color: 'red' }, content: [p('p0000000002', 'x')] }],
  ['table', { type: 'table', attrs: { id: 'table000001', width: '100%' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p('p0000000002', 'x')] }] }] }],
  ['tableCell', { type: 'table', attrs: { id: 'table000001' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [100] }, content: [p('p0000000002', 'x')] }] }] }],
  ['image', img('img00000001', { title: 'x' })],
  ['link', { type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://smartup.uz', target: '_self' } }] }] }],
];
test.each(withExtra)('неизвестный атрибут: %s', (_, block) => rejected(doc(block)));

test('каждый допустимый вид блока проходит схему по отдельности', () => {
  const blocks = (everyBlock as { blocks: { type: string }[] }).blocks;
  expect(new Set(blocks.map((b) => b.type))).toEqual(new Set(BLOCK_TYPES));
  for (const block of blocks) expect(safeParseSolutionDoc(doc(block)).success, block.type).toBe(true);
});

test('ссылки документа на файлы собираются из шагов и верхнего уровня', () => {
  expect(collectImageFileIds(parseSolutionDoc(clone(everyBlock)))).toEqual(['019ab8c0-0000-7000-8000-000000000001', '019ab8c0-0000-7000-8000-000000000002']);
  // Повтор одного файла даёт одну ссылку.
  expect(collectImageFileIds(parseSolutionDoc(doc(img('img00000001'), img('img00000002'))))).toEqual([FILE]);
});

test('допустимые ссылки: https и внутренние', () => {
  for (const href of ['https://smartup.uz/docs?a=1#b', '/help/a/12-slug', '/ru/tickets/new'])
    expect(safeParseSolutionDoc(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] })).success).toBe(true);
});
