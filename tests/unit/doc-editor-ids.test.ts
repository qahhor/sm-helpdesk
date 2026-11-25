import { getSchema } from '@tiptap/core';
import { Fragment, Node as PmNode, Slice } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { beforeAll, describe, expect, test } from 'vitest';
import { BLOCK_TYPES, collectBlockIds, MARK_TYPES, parseSolutionDoc, type SolutionDoc } from '@/modules/hdk/doc-schema';
import { moveBlock } from '@/ui/doc/editor/commands';
import { fromEditorJson, toEditorJson } from '@/ui/doc/editor/convert';
import { createSolutionExtensions } from '@/ui/doc/editor/extensions';
import { assignMissingIds, stableIdsPlugin } from '@/ui/doc/editor/stable-ids';
import everyBlock from '../fixtures/doc/every-block.json';

// Проба редактора (план M5, задача 1; ТЗ 18.4): устойчивые идентификаторы блоков переживают правку,
// перестановку, вставку скопированного и сохранение с загрузкой. Проверка идёт на модели ProseMirror
// с тем же набором расширений Tiptap, что у редактора: состояние редактора работает без браузера.

const schema = getSchema(createSolutionExtensions());
const fixture = everyBlock as SolutionDoc;

function stateOf(doc: SolutionDoc): EditorState {
  return EditorState.create({ doc: PmNode.fromJSON(schema, toEditorJson(doc)), plugins: [stableIdsPlugin()] });
}
/** Применяет транзакцию вместе с дописанными расширениями транзакциями (как это делает EditorView). */
function apply(state: EditorState, tr: Transaction): EditorState {
  return state.applyTransaction(tr).state;
}
const saved = (state: EditorState): SolutionDoc => parseSolutionDoc(fromEditorJson(state.doc.toJSON()));
/** Позиция блока верхнего уровня по идентификатору. */
function topPos(state: EditorState, id: string): number {
  let found = -1;
  state.doc.forEach((node, offset) => {
    if (node.attrs.id === id) found = offset;
  });
  if (found < 0) throw new Error(`нет блока ${id}`);
  return found;
}
const topIds = (state: EditorState) => saved(state).blocks.map((b) => b.attrs.id);

describe('схема редактора и схема документа описывают одно и то же', () => {
  test('виды узлов и отметок редактора совпадают с закрытым списком', () => {
    const parts = new Set(['doc', 'text', 'hardBreak', 'listItem', 'tableRow', 'tableCell', 'tableHeader']);
    expect(Object.keys(schema.nodes).filter((n) => !parts.has(n)).sort()).toEqual([...BLOCK_TYPES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...MARK_TYPES].sort());
  });

  test('документ со всеми блоками загружается в редактор и сохраняется без изменений', () => {
    const node = PmNode.fromJSON(schema, toEditorJson(fixture));
    node.check();
    expect(parseSolutionDoc(fromEditorJson(node.toJSON()))).toEqual(fixture);
  });

  test('сохранение и загрузка по кругу не меняют идентификаторы', () => {
    let doc = fixture;
    for (let round = 0; round < 3; round++) doc = saved(stateOf(structuredClone(doc)));
    expect(collectBlockIds(doc)).toEqual(collectBlockIds(fixture));
  });
});

describe('устойчивые идентификаторы', () => {
  let state: EditorState;
  beforeAll(() => {
    state = stateOf(fixture);
  });

  test('правка текста не меняет идентификаторы', () => {
    const pos = topPos(state, 'pwhat000001') + 3;
    const next = apply(state, state.tr.insertText('Новый текст ', pos));
    expect(collectBlockIds(saved(next))).toEqual(collectBlockIds(fixture));
  });

  test('новый абзац получает свой идентификатор', () => {
    const end = state.doc.content.size;
    const next = apply(state, state.tr.insert(end, schema.nodes.paragraph!.create(null, schema.text('Новый'))));
    const ids = collectBlockIds(saved(next));
    expect(ids).toHaveLength(collectBlockIds(fixture).length + 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('разделение абзаца: первая часть сохраняет идентификатор, вторая получает новый', () => {
    const pos = topPos(state, 'pwhat000001') + 5;
    const next = apply(state, state.tr.split(pos));
    const top = topIds(next);
    const at = top.indexOf('pwhat000001');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(top[at + 1]).toMatch(/^[a-z0-9]{12}$/);
    expect(new Set(collectBlockIds(saved(next))).size).toBe(collectBlockIds(saved(next)).length);
  });

  test('перестановка шагов с клавиатуры сохраняет идентификаторы шагов и их содержимого', () => {
    const inSecond = TextSelection.create(state.doc, topPos(state, 'step0000002') + 3);
    let moved: EditorState | undefined;
    moveBlock('up')(state.apply(state.tr.setSelection(inSecond)), (tr) => {
      moved = apply(state, tr);
    });
    expect(moved).toBeDefined();
    const top = topIds(moved!);
    expect(top.indexOf('step0000002')).toBe(top.indexOf('step0000001') - 1);
    expect(collectBlockIds(saved(moved!)).sort()).toEqual(collectBlockIds(fixture).sort());
    // Курсор остался в перенесённом шаге: можно жать сочетание ещё раз.
    expect(moved!.selection.$from.node(1).attrs.id).toBe('step0000002');
  });

  test('перетаскивание (удаление и вставка того же узла в одной транзакции) сохраняет идентификаторы', () => {
    const from = topPos(state, 'step0000001');
    const node = state.doc.nodeAt(from)!;
    const tr = state.tr.delete(from, from + node.nodeSize);
    tr.insert(tr.mapping.map(topPos(state, 'table000001')), node);
    const next = apply(state, tr);
    const top = topIds(next);
    expect(top.indexOf('step0000001')).toBe(top.indexOf('table000001') - 1);
    expect(collectBlockIds(saved(next)).sort()).toEqual(collectBlockIds(fixture).sort());
  });

  test.each([
    ['в конец документа', (s: EditorState) => s.doc.content.size],
    ['перед оригиналом', (s: EditorState) => topPos(s, 'h2what00001')],
  ])('вставка скопированного шага %s: оригинал сохраняет идентификаторы, копия получает новые', (_, where) => {
    const node = state.doc.nodeAt(topPos(state, 'step0000001'))!;
    const tr = state.tr.replace(where(state), where(state), new Slice(Fragment.from(node), 0, 0));
    const next = apply(state, tr);
    const after = saved(next);
    const ids = collectBlockIds(after);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of collectBlockIds(fixture)) expect(ids).toContain(id);
    expect(ids).toHaveLength(collectBlockIds(fixture).length + 3);
    // Оригинал на своём месте рядом со вторым шагом.
    const top = after.blocks.map((b) => b.attrs.id);
    expect(top.indexOf('step0000001')).toBe(top.indexOf('step0000002') - 1);
  });

  test('вырезать и вставить: идентификаторы переезжают вместе с блоком', () => {
    const from = topPos(state, 'callout0001');
    const node = state.doc.nodeAt(from)!;
    const cut = apply(state, state.tr.delete(from, from + node.nodeSize));
    const pasted = apply(cut, cut.tr.replace(0, 0, new Slice(Fragment.from(node), 0, 0)));
    expect(collectBlockIds(saved(pasted)).sort()).toEqual(collectBlockIds(fixture).sort());
  });

  test('документ без идентификаторов получает их при загрузке', () => {
    const bare = JSON.parse(JSON.stringify(toEditorJson(fixture)).replace(/"id":"[^"]+"/g, '"id":null'));
    const raw = EditorState.create({ doc: PmNode.fromJSON(schema, bare), plugins: [stableIdsPlugin()] });
    const tr = assignMissingIds(raw);
    expect(tr).not.toBeNull();
    const ids = collectBlockIds(saved(raw.apply(tr!)));
    expect(ids).toHaveLength(collectBlockIds(fixture).length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('документ с идентификаторами при загрузке не меняется', () => {
    expect(assignMissingIds(state)).toBeNull();
  });
});
