import { z } from 'zod';
import { BLOCK_ID, CALLOUT_TONES, FILE_ID, HEADING_LEVELS, ID_NODE_TYPES, isAllowedHref, MARK_TYPES, MAX_BLOCKS } from './doc-rules';

export * from './doc-rules';

// Документ решения (ТЗ 18.10, правка 2 раздела 10.6; план M5, решение 1 и задача 2).
// Источник истины: структура, а не HTML. Документ хранится как { version: 1, blocks }, где blocks это узлы
// ProseMirror в формате JSON редактора Tiptap (содержимое узла doc). Список блоков закрыт: всё, чего нет в схеме,
// отклоняется, а не пропускается. Отрисовка идёт компонентами по виду блока (src/ui/doc/DocView.tsx),
// HTML из документа не вставляется никогда.
//
// Устойчивый идентификатор (attrs.id) есть у каждого блока, в том числе у абзацев внутри шагов, списков,
// предупреждений и ячеек таблицы: на нём держатся перевод по абзацам (UX-W-06), замечания к абзацу (UX-W-14),
// проверка качества (KB-10) и выбор блоков для ответа AI (KB-46). Идентификаторы в документе не повторяются.
//
// Изображение несёт не адрес, а ссылку fileId на строку hdk_article_files (план M5, решение 16). Адрес строит страница
// по праву читателя: клиенту GET /help/a/{ref}/files/{fileId}, который отдаёт файл, только если он упомянут в видимой
// клиенту строке hdk_published (колонка file_ids, задача 4); сотруднику адрес рабочего места (задача 3). Чужой адрес,
// data: или путь к произвольному ресурсу портала в документ попасть не могут.

const MAX_TEXT = 10_000;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 20;
const MAX_LIST_DEPTH = 3;

const blockId = z.string().regex(BLOCK_ID);

const markSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({ type: z.literal('code') }),
  z.strictObject({ type: z.literal('link'), attrs: z.strictObject({ href: z.string().refine(isAllowedHref, 'ссылка вне списка допустимых') }) }),
]);

const textNode = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(MAX_TEXT),
  marks: z
    .array(markSchema)
    .max(MARK_TYPES.length)
    .refine((marks) => new Set(marks.map((m) => m.type)).size === marks.length, 'отметка повторяется')
    .optional(),
});
const hardBreak = z.strictObject({ type: z.literal('hardBreak') });
const inline = z.array(z.discriminatedUnion('type', [textNode, hardBreak])).max(2000);

const paragraph = z.strictObject({ type: z.literal('paragraph'), attrs: z.strictObject({ id: blockId }), content: inline.optional() });
const heading = z.strictObject({
  type: z.literal('heading'),
  attrs: z.strictObject({ id: blockId, level: z.union(HEADING_LEVELS.map((level) => z.literal(level))) }),
  content: inline.optional(),
});
const image = z.strictObject({
  type: z.literal('image'),
  attrs: z.strictObject({
    id: blockId,
    fileId: z.string().regex(FILE_ID, 'ссылка на файл решения'),
    alt: z.string().max(300).nullable(),
  }),
});

export type TextNode = z.infer<typeof textNode>;
export type InlineNode = TextNode | z.infer<typeof hardBreak>;
export type Mark = z.infer<typeof markSchema>;
export type ParagraphNode = z.infer<typeof paragraph>;
export type HeadingNode = z.infer<typeof heading>;
export type ImageNode = z.infer<typeof image>;
export type ListItemNode = { type: 'listItem'; content: [ParagraphNode, ...(ParagraphNode | ListNode)[]] };
export type BulletListNode = { type: 'bulletList'; attrs: { id: string }; content: ListItemNode[] };
export type OrderedListNode = { type: 'orderedList'; attrs: { id: string; start: number }; content: ListItemNode[] };
export type ListNode = BulletListNode | OrderedListNode;

// Списки вложены не глубже трёх уровней: схема строится по уровням, без рекурсии.
function listSchemas(depth: number): z.ZodType<ListNode> {
  const nested = depth > 1 ? [listSchemas(depth - 1)] : [];
  const item = z.strictObject({
    type: z.literal('listItem'),
    content: z.tuple([paragraph], nested.length > 0 ? z.union([paragraph, ...nested]) : paragraph).check(z.maxLength(50)),
  });
  const items = z.array(item).min(1).max(200);
  return z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('bulletList'), attrs: z.strictObject({ id: blockId }), content: items }),
    z.strictObject({ type: z.literal('orderedList'), attrs: z.strictObject({ id: blockId, start: z.int().min(1).max(10_000) }), content: items }),
  ]) as unknown as z.ZodType<ListNode>;
}
const list = listSchemas(MAX_LIST_DEPTH);

const step = z.strictObject({
  type: z.literal('step'),
  attrs: z.strictObject({ id: blockId }),
  // Шаг начинается с текста, дальше абзацы и изображения (UX-W-02: к шагу прикладывается скриншот).
  content: z.tuple([paragraph], z.union([paragraph, image])).check(z.maxLength(20)),
});
const callout = z.strictObject({
  type: z.literal('callout'),
  attrs: z.strictObject({ id: blockId, tone: z.enum(CALLOUT_TONES) }),
  content: z.array(z.union([paragraph, list])).min(1).max(20),
});
const cell = z.strictObject({
  type: z.enum(['tableCell', 'tableHeader']),
  attrs: z.strictObject({ colspan: z.int().min(1).max(MAX_TABLE_COLS), rowspan: z.int().min(1).max(MAX_TABLE_ROWS) }),
  content: z.array(paragraph).min(1).max(20),
});
const table = z.strictObject({
  type: z.literal('table'),
  attrs: z.strictObject({ id: blockId }),
  content: z.array(z.strictObject({ type: z.literal('tableRow'), content: z.array(cell).min(1).max(MAX_TABLE_COLS) })).min(1).max(MAX_TABLE_ROWS),
});

export type StepNode = z.infer<typeof step>;
export type CalloutNode = { type: 'callout'; attrs: { id: string; tone: (typeof CALLOUT_TONES)[number] }; content: (ParagraphNode | ListNode)[] };
export type TableNode = z.infer<typeof table>;
export type TableCellNode = z.infer<typeof cell>;
export type Block = HeadingNode | ParagraphNode | ListNode | StepNode | CalloutNode | TableNode | ImageNode;
export type SolutionDoc = { version: 1; blocks: Block[] };

const block = z.union([heading, paragraph, list, step, callout, table, image]);

/** Все идентификаторы блоков документа в порядке обхода. */
export function collectBlockIds(value: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    const { type, attrs, content } = node as { type?: unknown; attrs?: { id?: unknown }; content?: unknown };
    if (typeof type === 'string' && (ID_NODE_TYPES as readonly string[]).includes(type) && typeof attrs?.id === 'string') ids.push(attrs.id);
    if (Array.isArray(content)) content.forEach(walk);
  };
  if (value && typeof value === 'object' && Array.isArray((value as { blocks?: unknown }).blocks)) (value as { blocks: unknown[] }).blocks.forEach(walk);
  return ids;
}

/** Файлы решения, на которые ссылается документ, без повторов, в порядке обхода. Пишутся в hdk_published.file_ids. */
export function collectImageFileIds(doc: SolutionDoc): string[] {
  const ids = new Set<string>();
  const walk = (node: { type: string; attrs?: unknown; content?: unknown }) => {
    if (node.type === 'image') ids.add((node as ImageNode).attrs.fileId.toLowerCase());
    if (Array.isArray(node.content)) for (const child of node.content) if (child && typeof child === 'object') walk(child as { type: string });
  };
  doc.blocks.forEach(walk);
  return [...ids];
}

export const solutionDocSchema = z
  .strictObject({ version: z.literal(1), blocks: z.array(block).max(MAX_BLOCKS) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const id of collectBlockIds(value)) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `идентификатор блока повторяется: ${id}` });
      seen.add(id);
    }
  }) as unknown as z.ZodType<SolutionDoc>;

/** Проверка документа перед сохранением и перед отрисовкой. Бросает ошибку Zod. */
export function parseSolutionDoc(value: unknown): SolutionDoc {
  return solutionDocSchema.parse(value);
}

export function safeParseSolutionDoc(value: unknown) {
  return solutionDocSchema.safeParse(value);
}
