import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { BLOCK_ID, ID_NODE_TYPES } from '@/modules/hdk/api/doc-rules';

// Устойчивые идентификаторы блоков (ТЗ 18.10 и 18.4; план M5, задача 1). Своё расширение на ProseMirror, без
// пакета UniqueID: правило выбора, кому оставить идентификатор, здесь своё и проверяется тестами на модели.
//
// После каждой правки документа:
// - узел без идентификатора или с недопустимым получает новый;
// - при повторе идентификатор остаётся у узла вне изменённого участка (оригинал), а вставленная копия получает
//   новый. Поэтому вставка скопированного блока перед оригиналом не отнимает идентификатор у оригинала;
// - перетаскивание и перенос с клавиатуры это удаление и вставка того же узла в одной транзакции: повтора нет,
//   идентификатор переезжает вместе с блоком. Так же ведёт себя "вырезать и вставить".

const ID_TYPES: ReadonlySet<string> = new Set(ID_NODE_TYPES);
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Новый идентификатор: 12 знаков из строчных латинских букв и цифр. Работает и на адресе без https. */
export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

type Range = { from: number; to: number };

/** Изменённые участки всех транзакций в координатах итогового документа. */
function changedRanges(trs: readonly Transaction[]): Range[] {
  const maps = trs.flatMap((tr) => tr.mapping.maps);
  const ranges: Range[] = [];
  maps.forEach((map, index) =>
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      let from = newStart;
      let to = newEnd;
      for (const later of maps.slice(index + 1)) {
        from = later.map(from, -1);
        to = later.map(to, 1);
      }
      ranges.push({ from, to });
    }),
  );
  return ranges;
}

/**
 * Транзакция, которая чинит идентификаторы, или null, если чинить нечего.
 * ranges: изменённые участки; null значит "весь документ" (загрузка), тогда идентификатор остаётся у первого.
 */
function fixIds(state: EditorState, ranges: Range[] | null, generate: () => string): Transaction | null {
  const items: { pos: number; id: unknown; changed: boolean; kept?: boolean }[] = [];
  state.doc.descendants((node, pos) => {
    if (!ID_TYPES.has(node.type.name)) return;
    const end = pos + node.nodeSize;
    const changed = ranges === null || ranges.some((range) => pos < range.to && end > range.from);
    items.push({ pos, id: node.attrs.id, changed });
  });
  const used = new Set<string>();
  // Сначала идентификаторы узлов вне изменённых участков: их никто не отнимает.
  for (const item of items)
    if (!item.changed && typeof item.id === 'string' && BLOCK_ID.test(item.id) && !used.has(item.id)) {
      used.add(item.id);
      item.kept = true;
    }
  let tr: Transaction | null = null;
  for (const item of items) {
    if (item.kept) continue;
    if (typeof item.id === 'string' && BLOCK_ID.test(item.id) && !used.has(item.id)) {
      used.add(item.id);
      continue;
    }
    let id = generate();
    while (used.has(id)) id = generate();
    used.add(id);
    // Смена атрибута не сдвигает позиции, поэтому позиции из обхода остаются верными.
    tr = (tr ?? state.tr).setNodeAttribute(item.pos, 'id', id);
  }
  return tr?.setMeta('addToHistory', false) ?? null;
}

/** Идентификаторы для документа при загрузке в редактор: недостающие и повторные получают новые. */
export function assignMissingIds(state: EditorState, generate: () => string = newBlockId): Transaction | null {
  return fixIds(state, null, generate);
}

export const stableIdsKey = new PluginKey('stableIds');

export function stableIdsPlugin(generate: () => string = newBlockId): Plugin {
  return new Plugin({
    key: stableIdsKey,
    appendTransaction(trs, _oldState, newState) {
      if (!trs.some((tr) => tr.docChanged)) return null;
      return fixIds(newState, changedRanges(trs), generate);
    },
  });
}
