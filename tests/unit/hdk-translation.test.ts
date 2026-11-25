import { expect, test } from 'vitest';
import type { SolutionDoc } from '@/modules/hdk/doc-schema';
import { applySegments, changedBlockIds, compareInvariants, textSegments } from '@/modules/hdk/translation';

// Перевод по блокам и сверка с оригиналом (план M5, задача 6, решение 9; поправка 101).

const p = (id: string, ...content: object[]) => ({ type: 'paragraph', attrs: { id }, content });
const t = (text: string, href?: string) => ({ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) });
const step = (id: string, text: string) => ({ type: 'step', attrs: { id }, content: [p(`${id}p`, t(text))] });
const doc = (...blocks: object[]) => ({ version: 1, blocks }) as unknown as SolutionDoc;

const ORIGINAL = doc(
  { type: 'heading', attrs: { id: 'h000000001', level: 2 }, content: [t('Что видит пользователь')] },
  p('p000000001', t('Ошибка 504 при отчёте за 2026 год. Откройте '), t('документацию', 'https://docs.smartup.uz/a'), t(' и нажмите «Обновить».')),
  step('s000000001', 'Откройте раздел «Склад»'),
  step('s000000002', 'Нажмите «Провести»'),
);

test('куски текста: текстовые узлы абзацев и заголовков, в том числе внутри шагов', () => {
  expect(textSegments(ORIGINAL).map((s) => s.id)).toEqual(['h000000001.0', 'p000000001.0', 'p000000001.1', 'p000000001.2', 's000000001p.0', 's000000002p.0']);
});

test('перевод ложится в копию оригинала: адрес ссылки и устройство из оригинала, неполный ответ не принимается', () => {
  const map = new Map(textSegments(ORIGINAL).map((s) => [s.id, `EN ${s.text}`]));
  map.set('p000000001.1', 'documentation');
  const out = applySegments(ORIGINAL, map)!;
  expect(out.blocks).toHaveLength(4);
  expect(JSON.stringify(out)).toContain('"href":"https://docs.smartup.uz/a"');
  expect(JSON.stringify(out)).toContain('"text":"documentation"');
  expect(JSON.stringify(ORIGINAL)).not.toContain('EN ');
  map.delete('s000000002p.0');
  expect(applySegments(ORIGINAL, map)).toBeNull();
});

test('сверка: тот же перевод без расхождений; лишняя ссылка, телефон, другое число шагов и кавычек находятся', () => {
  const same = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.text.replace('Откройте', 'Open')])))!;
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: same })).toEqual([]);

  const extraLink = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.id === 's000000002p.0' ? 'Click "Post" at https://evil.example/x' : s.text])))!;
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: extraLink }).map((i) => i.kind)).toEqual(['links']);

  const phone = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.id === 's000000001p.0' ? 'Call +998 90 123 45 67 «Склад»' : s.text])))!;
  const issues = compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: phone });
  expect(issues.map((i) => i.kind)).toEqual(['numbers']);
  expect(issues[0]!.translation).toContain('998');

  const fewer = doc(...(ORIGINAL.blocks.slice(0, 3) as object[]));
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: fewer }).map((i) => i.kind)).toEqual(['quotes', 'steps']);
});

test('изменившиеся блоки оригинала по идентификаторам', () => {
  const next = structuredClone(ORIGINAL) as unknown as { blocks: { content: { text: string }[] }[] };
  next.blocks[1]!.content[0]!.text = 'Ошибка 502';
  const added = doc(...(next.blocks as object[]), step('s000000003', 'Новый шаг'));
  expect(changedBlockIds(ORIGINAL, added)).toEqual(['p000000001', 's000000003']);
});
