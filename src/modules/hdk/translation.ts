import type { SolutionDoc } from './doc-schema';

// Перевод решения (ТЗ FR-SOL-06, 18, UX-W-06, поправка 101; план M5, задача 6, решение 9). Чистые функции без базы.
//
// Перевод держится на устойчивых идентификаторах блоков: черновик перевода это копия документа оригинала с теми же
// идентификаторами, где заменён только текст. Модель получает куски текста (textSegments) и возвращает их по
// идентификаторам; адреса ссылок, изображения, разметку и порядок блоков переносит код (applySegments), модель их не
// видит и изменить не может.
//
// Перед публикацией машинного перевода код сверяет его с оригиналом (compareInvariants): ссылки, числа, число
// фрагментов в кавычках и число шагов. Расхождение не даёт публиковать машинный текст, пока сотрудник не подтвердит
// перевод. Изменившиеся блоки оригинала подсвечиваются по идентификаторам (changedBlockIds).

type Inline = { type: string; text?: string; marks?: { type: string; attrs?: { href?: string } }[] };
type Node = { type: string; attrs?: { id?: string }; content?: unknown[] };

export type Segment = { id: string; text: string };

/** Куски текста документа: каждый текстовый узел абзаца или заголовка, идентификатор "<блок>.<номер узла>". */
export function textSegments(doc: SolutionDoc): Segment[] {
  const out: Segment[] = [];
  const walk = (node: Node) => {
    if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs?.id) {
      (node.content ?? []).forEach((child, index) => {
        const inline = child as Inline;
        if (inline.type === 'text' && inline.text && inline.text.trim() !== '') out.push({ id: `${node.attrs!.id}.${index}`, text: inline.text });
      });
      return;
    }
    for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as Node);
  };
  for (const block of doc.blocks) walk(block as unknown as Node);
  return out;
}

/**
 * Документ с переведёнными кусками: копия оригинала, где у каждого куска заменён только текст. Нет перевода хотя бы
 * одного куска или он пустой: null (ответ модели не принимается). Лишние идентификаторы ответа не используются.
 */
export function applySegments(doc: SolutionDoc, translated: ReadonlyMap<string, string>): SolutionDoc | null {
  const copy = structuredClone(doc);
  let complete = true;
  const walk = (node: Node) => {
    if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs?.id) {
      (node.content ?? []).forEach((child, index) => {
        const inline = child as Inline;
        if (inline.type !== 'text' || !inline.text || inline.text.trim() === '') return;
        const text = translated.get(`${node.attrs!.id}.${index}`)?.replace(/[\r\n]+/g, ' ');
        if (!text || text.trim() === '') complete = false;
        else inline.text = text;
      });
      return;
    }
    for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as Node);
  };
  for (const block of copy.blocks) walk(block as unknown as Node);
  return complete ? copy : null;
}

/** Блоки верхнего уровня, которые изменились с версии source: текст или устройство другое, или блока не было. */
export function changedBlockIds(source: SolutionDoc, current: SolutionDoc): string[] {
  const before = new Map(source.blocks.map((block) => [block.attrs.id, JSON.stringify(block)]));
  return current.blocks.filter((block) => before.get(block.attrs.id) !== JSON.stringify(block)).map((block) => block.attrs.id);
}

export const INVARIANT_KINDS = ['links', 'numbers', 'quotes', 'steps'] as const;
export type InvariantKind = (typeof INVARIANT_KINDS)[number];
/** Расхождение перевода с оригиналом: что в оригинале и что в переводе (для шагов и кавычек их число). */
export type InvariantIssue = { kind: InvariantKind; original: string[]; translation: string[] };

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
const QUOTED = /«[^«»]+»|"[^"]+"|“[^“”]+”|„[^„“”]+[“”]/g;
const TRAILING = /[.,;:!?)\]]+$/;

function collect(content: { title: string; doc: SolutionDoc }) {
  const texts: string[] = [content.title];
  const links: string[] = [];
  let steps = 0;
  const walk = (node: Node) => {
    if (node.type === 'step') steps += 1;
    if (node.type === 'paragraph' || node.type === 'heading') {
      const line: string[] = [];
      for (const child of node.content ?? []) {
        const inline = child as Inline;
        if (inline.type === 'text') line.push(inline.text ?? '');
        for (const mark of inline.marks ?? []) if (mark.type === 'link' && mark.attrs?.href) links.push(mark.attrs.href);
      }
      texts.push(line.join(''));
      return;
    }
    for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as Node);
  };
  for (const block of content.doc.blocks) walk(block as unknown as Node);
  for (const text of texts) for (const match of text.matchAll(URL_IN_TEXT)) links.push(match[0].replace(TRAILING, ''));
  const numbers = texts.flatMap((text) => text.replace(URL_IN_TEXT, ' ').match(/\d+/g) ?? []);
  const quotes = texts.reduce((sum, text) => sum + (text.match(QUOTED)?.length ?? 0), 0);
  return { links: links.sort(), numbers: numbers.sort(), quotes, steps };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Сверка перевода с оригиналом (поправка 101): те же адреса ссылок, те же числа, столько же фрагментов в кавычках
 * (названия экранов и кнопок; сам текст в кавычках переводится) и столько же шагов. Пусто: расхождений нет.
 */
export function compareInvariants(original: { title: string; doc: SolutionDoc }, translation: { title: string; doc: SolutionDoc }): InvariantIssue[] {
  const a = collect(original);
  const b = collect(translation);
  const issues: InvariantIssue[] = [];
  if (!same(a.links, b.links)) issues.push({ kind: 'links', original: a.links, translation: b.links });
  if (!same(a.numbers, b.numbers)) issues.push({ kind: 'numbers', original: a.numbers, translation: b.numbers });
  if (a.quotes !== b.quotes) issues.push({ kind: 'quotes', original: [String(a.quotes)], translation: [String(b.quotes)] });
  if (a.steps !== b.steps) issues.push({ kind: 'steps', original: [String(a.steps)], translation: [String(b.steps)] });
  return issues;
}
