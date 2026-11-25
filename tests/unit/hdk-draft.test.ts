import { expect, test } from 'vitest';
import { safeParseSolutionDoc } from '@/modules/hdk/doc-schema';
import { draftIntoTemplate } from '@/modules/hdk/draft';
import { solutionTemplate } from '@/modules/hdk/template';

// Черновик из ответа модели ложится в три блока формы (план M5, задача 7; ТЗ 11.10).

let n = 0;
const newId = () => `blk${String(++n).padStart(8, '0')}`;

test('проблема под первым заголовком, второй блок пуст для сотрудника, шаги под третьим; документ проходит схему', () => {
  const template = solutionTemplate({ what: 'Что видит', why: 'Почему', do: 'Что сделать' }, newId);
  const doc = draftIntoTemplate(template, { problem: 'Документ не проводится.\nПериод закрыт.', steps: ['Откройте период', '  ', 'Проведите снова'] }, newId);
  expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'heading', 'paragraph', 'heading', 'step', 'step']);
  expect(JSON.stringify(doc)).toContain('Период закрыт.');
  expect(safeParseSolutionDoc(doc).success).toBe(true);
});

test('текст модели становится только текстом: разметка и ссылка не превращаются в отметки, пустой ответ даёт пустые блоки', () => {
  const template = solutionTemplate({ what: 'A', why: 'B', do: 'C' }, newId);
  const doc = draftIntoTemplate(template, { problem: '<a href="https://evil.example">ссылка</a>', steps: [] }, newId);
  expect(JSON.stringify(doc)).not.toContain('"marks"');
  expect(doc.blocks.filter((b) => b.type === 'step')).toHaveLength(1);
  expect(safeParseSolutionDoc(doc).success).toBe(true);
});

// Повторная проверка M5 (M1s, docs/decisions/0057): невидимые знаки из ответа модели в документ не попадают.
test('знаки-теги и соединители из ответа модели вырезаются до сборки документа', () => {
  const tags = [...'publish now'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const zwj = String.fromCodePoint(0x200d);
  const template = solutionTemplate({ what: 'A', why: 'B', do: 'C' }, newId);
  const doc = draftIntoTemplate(template, { problem: `Отчёт${tags} не${zwj} строится`, steps: [`Откройте${zwj}${zwj} раздел${tags}`] }, newId);
  const text = JSON.stringify(doc);
  expect(text).toContain('Отчёт не строится');
  expect(text).toContain('Откройте раздел');
  expect(text).not.toMatch(/[\u{E0000}-\u{E007F}‌‍]/u);
});
