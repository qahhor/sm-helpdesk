import type { JSONContent } from '@tiptap/core';
import type { SolutionDoc } from '@/modules/hdk/api/doc';

// Хранимый документ решения { version: 1, blocks } и документ редактора { type: 'doc', content } различаются
// только обёрткой: блоки это те же узлы ProseMirror (план M5, задача 1; ТЗ 18.10).

export function toEditorJson(doc: SolutionDoc): JSONContent {
  // У редактора в документе всегда есть хотя бы один блок. Идентификатор пустому абзацу даст расширение.
  return { type: 'doc', content: doc.blocks.length > 0 ? (doc.blocks as JSONContent[]) : [{ type: 'paragraph', attrs: { id: null } }] };
}

/** Документ для сохранения. Не проверен: перед записью и отрисовкой его проверяет схема (parseSolutionDoc). */
export function fromEditorJson(json: JSONContent): { version: 1; blocks: unknown[] } {
  const blocks = json.content ?? [];
  // Единственный пустой абзац это пустой документ.
  const empty = blocks.length === 1 && blocks[0]?.type === 'paragraph' && !blocks[0].content?.length;
  return { version: 1, blocks: empty ? [] : blocks };
}
