import { NodeSelection, Selection, TextSelection, type Command } from '@tiptap/pm/state';

// Перенос блока выше или ниже с клавиатуры (план M5, задача 1): замена перетаскиванию для тех, кто не работает
// мышью (доступность). Переносится блок верхнего уровня, в котором стоит курсор: шаг, абзац, таблица.
// Перенос это удаление и вставка того же узла, поэтому идентификаторы блока и его содержимого не меняются.

export function moveBlock(direction: 'up' | 'down'): Command {
  return (state, dispatch) => {
    const { selection } = state;
    const top = selection instanceof NodeSelection && selection.$from.depth === 0;
    if (!top && selection.$from.depth < 1) return false;
    const index = selection.$from.index(0);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= state.doc.childCount) return false;
    if (!dispatch) return true;

    const node = state.doc.child(index);
    let start = 0;
    for (let i = 0; i < index; i++) start += state.doc.child(i).nodeSize;
    const offset = selection.from - start;
    const tr = state.tr.delete(start, start + node.nodeSize);
    // Вверх: перед предыдущим блоком. Вниз: после следующего, который после удаления начинается с start.
    const insertAt = direction === 'up' ? start - state.doc.child(target).nodeSize : start + state.doc.child(target).nodeSize;
    tr.insert(insertAt, node);
    if (top) tr.setSelection(NodeSelection.create(tr.doc, insertAt));
    else {
      const $pos = tr.doc.resolve(insertAt + offset);
      tr.setSelection($pos.parent.inlineContent ? TextSelection.create(tr.doc, insertAt + offset) : Selection.near($pos));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
