import { describe, expect, test } from 'vitest';
import { BLOCK_TYPES, MAX_BLOCKS, parseSolutionDoc, safeParseSolutionDoc } from '@/modules/hdk/doc-schema';
import everyBlock from '../fixtures/doc/every-block.json';

// Документ решения (план M5, решение 1 и задача 2; ТЗ 18.10): закрытый список блоков этапа 1, у каждого
// блока устойчивый идентификатор, ссылки только https, mailto и внутренние.

const clone = <T>(value: T): T => structuredClone(value);
const p = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const doc = (...blocks: unknown[]) => ({ version: 1, blocks });
const rejected = (value: unknown) => expect(safeParseSolutionDoc(value).success).toBe(false);

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
  const step = { type: 'step', attrs: { id: 'step0000009' }, content: [p('pstep000009', 'Нажмите'), { type: 'image', attrs: { id: 'img00000009', src: '/files/1', alt: 'Кнопка' } }] };
  expect(parseSolutionDoc(doc(step)).blocks[0]).toEqual(step);
});

test('шаг начинается с текста, изображение первым не встаёт', () => {
  rejected(doc({ type: 'step', attrs: { id: 'step0000009' }, content: [{ type: 'image', attrs: { id: 'img00000009', src: '/f', alt: '' } }] }));
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
  test.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'http://smartup.uz', '//evil.example/x', '/\\evil.example', 'data:text/html,<script>', 'vbscript:x', 'https://', 'mailto:'])(
    'ссылка %s',
    (href) => rejected(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] })),
  );
  test.each(['https://evil.example/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '//evil.example/a.png', 'file:///C:/a.png'])('адрес изображения %s', (src) =>
    rejected(doc({ type: 'image', attrs: { id: 'img00000001', src, alt: '' } })),
  );
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

test('допустимые ссылки: https, mailto, внутренние', () => {
  for (const href of ['https://smartup.uz/docs?a=1#b', 'mailto:help@smartup.uz', '/help/a/12-slug', '/ru/tickets/new'])
    expect(safeParseSolutionDoc(doc({ type: 'paragraph', attrs: { id: 'p0000000001' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] })).success).toBe(true);
});
