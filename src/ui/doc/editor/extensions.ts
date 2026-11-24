import { Extension, mergeAttributes, Node, type Extensions, type NodeViewRenderer } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import Image from '@tiptap/extension-image';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Text from '@tiptap/extension-text';
import { Dropcursor, Gapcursor, UndoRedo } from '@tiptap/extensions';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CALLOUT_TONES, HEADING_LEVELS, ID_NODE_TYPES, isAllowedHref, isFileId } from '@/modules/hdk/api/doc-rules';
import { moveBlock } from './commands';
import { assignMissingIds, stableIdsPlugin } from './stable-ids';

// Набор расширений Tiptap редактора решения (план M5, задача 1): ровно закрытый список блоков документа
// (src/modules/hdk/doc-rules.ts). Тот же набор строит схему в тестах модели, поэтому здесь нет React.
//
// Атрибуты каждого расширения сведены к тем, что есть в схеме документа: ширина колонок, выравнивание, target
// и rel ссылки, title и размеры изображения не хранятся. Ничего из разметки не задаёт встроенный стиль:
// политика CSP портала запрещает атрибут style (поэтому у таблицы свой renderHTML без colgroup).

type Tone = (typeof CALLOUT_TONES)[number];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    solution: {
      /** Шаг из текущего абзаца или обратно в абзац. */
      toggleStep: () => ReturnType;
      /** Предупреждение вокруг текущих блоков или обратно. */
      toggleCallout: (tone: Tone) => ReturnType;
      /** Перенос блока верхнего уровня выше или ниже. */
      moveBlock: (direction: 'up' | 'down') => ReturnType;
    };
  }
}

const clampSpan = (value: string | null, max: number) => Math.min(max, Math.max(1, Number.parseInt(value ?? '1', 10) || 1));

const StableIds = Extension.create({
  name: 'stableIds',
  addGlobalAttributes() {
    return [
      {
        types: [...ID_NODE_TYPES],
        attributes: {
          id: {
            default: null,
            // При разделении абзаца вторая часть получает новый идентификатор, а не копию.
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute('data-id'),
            renderHTML: (attributes) => (typeof attributes.id === 'string' ? { 'data-id': attributes.id } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [stableIdsPlugin()];
  },
  onCreate() {
    const tr = assignMissingIds(this.editor.state);
    if (tr) this.editor.view.dispatch(tr);
  },
});

const SolutionHeading = Heading.extend({
  addAttributes() {
    return { level: { default: 2, rendered: false } };
  },
}).configure({ levels: [...HEADING_LEVELS] });

/** Адрес файла решения для показа в редакторе. Строит страница (решение 16): в документе хранится только fileId. */
export type ImageSrcResolver = (fileId: string) => string | null;

function createImage(imageSrc: ImageSrcResolver | undefined) {
  return Image.extend({
    addAttributes() {
      return {
        // Ссылка на строку hdk_article_files (план M5, решение 16), адреса в документе нет.
        fileId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-file-id'),
          renderHTML: (attributes) => {
            const fileId = typeof attributes.fileId === 'string' ? attributes.fileId : null;
            const src = fileId ? imageSrc?.(fileId) : null;
            return { 'data-file-id': fileId, ...(src ? { src } : {}) };
          },
        },
        alt: { default: null },
      };
    },
    parseHTML() {
      // Изображение из буфера без ссылки на файл решения (file://, data:, другой сайт, любой адрес) не вставляется:
      // файлы решения загружаются в хранилище портала (задача 3), в документ попадает только их идентификатор.
      return [{ tag: 'img[data-file-id]', getAttrs: (element) => (isFileId(element.getAttribute('data-file-id')) ? null : false) }];
    },
  }).configure({ inline: false, allowBase64: false });
}

const SolutionLink = Link.extend({
  addAttributes() {
    return { href: { default: null, parseHTML: (element) => element.getAttribute('href') } };
  },
}).configure({
  openOnClick: false,
  autolink: false,
  linkOnPaste: false,
  // Ссылки только https и внутренние (план M5, задача 2). Остальные при вставке теряют ссылку, текст остаётся.
  isAllowedUri: (url) => isAllowedHref(url),
  HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
});

const SolutionOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      start: { default: 1, parseHTML: (element) => clampSpan(element.getAttribute('start'), 10_000) },
    };
  },
});

const SolutionListItem = ListItem.extend({ content: 'paragraph (bulletList | orderedList)*' });

const SolutionTable = Table.extend({
  renderHTML({ HTMLAttributes }) {
    return ['table', HTMLAttributes, ['tbody', 0]];
  },
}).configure({ resizable: false, View: null, allowTableNodeSelection: false });

const cellAttributes = () => ({
  colspan: { default: 1, parseHTML: (element: HTMLElement) => clampSpan(element.getAttribute('colspan'), 20) },
  rowspan: { default: 1, parseHTML: (element: HTMLElement) => clampSpan(element.getAttribute('rowspan'), 200) },
});
const SolutionTableCell = TableCell.extend({ content: 'paragraph+', addAttributes: cellAttributes });
const SolutionTableHeader = TableHeader.extend({ content: 'paragraph+', addAttributes: cellAttributes });

const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: '(paragraph | bulletList | orderedList)+',
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: 'info' satisfies Tone,
        parseHTML: (element) => (element.getAttribute('data-tone') === 'warning' ? 'warning' : 'info'),
        renderHTML: (attributes) => ({ 'data-tone': attributes.tone }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes({ 'data-callout': '', class: 'doc-callout' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      toggleCallout:
        (tone) =>
        ({ editor, commands }) => {
          if (editor.isActive('callout', { tone })) return commands.lift('callout');
          if (editor.isActive('callout')) return commands.updateAttributes('callout', { tone });
          return commands.wrapIn('callout', { tone });
        },
    };
  },
});

function createStep(view: NodeViewRenderer | undefined) {
  return Node.create({
    name: 'step',
    group: 'block',
    // Шаг начинается с текста, к нему прикладывается изображение (UX-W-02).
    content: 'paragraph (paragraph | image)*',
    defining: true,
    // Шаг перетаскивается за ручку (data-drag-handle в виде узла).
    draggable: true,
    parseHTML() {
      return [{ tag: 'div[data-step]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-step': '', class: 'doc-step' }, HTMLAttributes), 0];
    },
    addNodeView() {
      return view ?? null;
    },
    addProseMirrorPlugins() {
      // Номер шага по порядку соседних шагов: атрибут вида узла, номер в документе не хранится.
      return [
        new Plugin({
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              let number = 0;
              state.doc.forEach((node, offset) => {
                number = node.type.name === 'step' ? number + 1 : 0;
                if (number > 0) decorations.push(Decoration.node(offset, offset + node.nodeSize, { 'data-step-number': String(number) }));
              });
              return DecorationSet.create(state.doc, decorations);
            },
          },
        }),
      ];
    },
    addCommands() {
      return {
        toggleStep:
          () =>
          ({ editor, commands }) =>
            editor.isActive('step') ? commands.lift('step') : commands.wrapIn('step'),
        moveBlock:
          (direction) =>
          ({ state, dispatch }) =>
            moveBlock(direction)(state, dispatch),
      };
    },
    addKeyboardShortcuts() {
      return {
        'Alt-Shift-ArrowUp': () => this.editor.commands.moveBlock('up'),
        'Alt-Shift-ArrowDown': () => this.editor.commands.moveBlock('down'),
        // Enter в пустом последнем абзаце шага начинает следующий шаг, в пустом шаге возвращает обычный абзац.
        Enter: () =>
          this.editor.commands.command(({ state, tr, dispatch }) => {
            const { $from, empty } = state.selection;
            if (!empty || $from.depth !== 2 || $from.node(1).type.name !== 'step') return false;
            const step = $from.node(1);
            if ($from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0 || $from.index(1) !== step.childCount - 1) return false;
            if (!dispatch) return true;
            const paragraph = state.schema.nodes.paragraph!;
            if (step.childCount === 1) {
              tr.replaceWith($from.before(1), $from.after(1), paragraph.create());
              tr.setSelection(TextSelection.create(tr.doc, $from.before(1) + 1));
            } else {
              tr.delete($from.before(2), $from.after(2));
              const at = tr.mapping.map($from.after(1));
              tr.insert(at, step.type.create(null, paragraph.create()));
              tr.setSelection(TextSelection.create(tr.doc, at + 2));
            }
            dispatch(tr.scrollIntoView());
            return true;
          }),
      };
    },
  });
}

export type SolutionExtensionOptions = {
  /** Вид шага с ручкой перетаскивания (React). Без него шаг рисуется разметкой renderHTML: так в тестах модели. */
  stepView?: NodeViewRenderer;
  /** Адрес файла для показа изображения. Без него изображение рисуется без адреса: так в тестах модели. */
  imageSrc?: ImageSrcResolver;
};

// Подсветка находок проверки FR-SOL-04 (план M5, задача 4): блоки с находками получают класс doc-finding.
// Список идентификаторов приходит от страницы метой транзакции, документ при этом не меняется.
export const findingsKey = new PluginKey<ReadonlySet<string>>('solutionFindings');

const Findings = Extension.create({
  name: 'solutionFindings',
  addProseMirrorPlugins() {
    return [
      new Plugin<ReadonlySet<string>>({
        key: findingsKey,
        state: {
          init: () => new Set<string>(),
          apply: (tr, value) => (tr.getMeta(findingsKey) as ReadonlySet<string> | undefined) ?? value,
        },
        props: {
          decorations(state: EditorState) {
            const ids = findingsKey.getState(state);
            if (!ids || ids.size === 0) return null;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (typeof node.attrs.id === 'string' && ids.has(node.attrs.id)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'doc-finding' }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export function createSolutionExtensions(options: SolutionExtensionOptions = {}): Extensions {
  return [
    Document,
    Text,
    Paragraph,
    SolutionHeading,
    HardBreak,
    Bold,
    Italic,
    Code,
    SolutionLink,
    BulletList,
    SolutionOrderedList,
    SolutionListItem,
    ListKeymap,
    createStep(options.stepView),
    Callout,
    createImage(options.imageSrc),
    SolutionTable,
    TableRow,
    SolutionTableCell,
    SolutionTableHeader,
    StableIds,
    Findings,
    UndoRedo,
    Dropcursor,
    Gapcursor,
  ];
}
