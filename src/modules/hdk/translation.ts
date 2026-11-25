import { stripInvisible } from '@/modules/hdc/pref';
import { findInText } from './checks';
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
        // Невидимые знаки ответа модели (знаки-теги, соединители) в документ не попадают (0057, M1s).
        const raw = translated.get(`${node.attrs!.id}.${index}`);
        const text = raw === undefined ? undefined : stripInvisible(raw).replace(/[\r\n]+/g, ' ');
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

export const INVARIANT_KINDS = ['links', 'numbers', 'quotes', 'steps', 'data'] as const;
export type InvariantKind = (typeof INVARIANT_KINDS)[number];
/** Расхождение перевода с оригиналом: что в оригинале и что в переводе (для шагов и кавычек их число). */
export type InvariantIssue = { kind: InvariantKind; original: string[]; translation: string[] };

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
/** Адрес почты и голый домен без схемы (evil-smartup.com): тоже ссылки, модель не должна их дописывать (0057, M2s). */
const EMAIL_IN_TEXT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const DOMAIN_IN_TEXT = /(?<![\p{L}\p{N}@._/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?![\p{L}\p{N}_-])/giu;
/** Число; разряды через пробел, неразрывный пробел, запятую или точку (1 000, 1,000) считаются одним числом (M4m). */
const NUMBER = /\d{1,3}(?:[ \u00A0\u202F,.]\d{3})+(?!\d)|\d+/g;
const QUOTED = /«[^«»]+»|"[^"]+"|“[^“”]+”|„[^„“”]+[“”]/g;
const TRAILING = /[.,;:!?)\]]+$/;

const numbersOf = (text: string) => (text.replace(URL_IN_TEXT, ' ').match(NUMBER) ?? []).map((n) => n.replace(/\D/g, ''));

function collect(content: { title: string; doc: SolutionDoc }) {
  const texts: string[] = [content.title];
  const links: string[] = [];
  // Числа каждого шага по порядку шагов: число, переставленное в другой шаг, тоже расхождение (M4m).
  const stepNumbers: string[][] = [];
  let step = -1;
  let steps = 0;
  const walk = (node: Node) => {
    if (node.type === 'step') {
      steps += 1;
      const outer = step;
      step = stepNumbers.push([]) - 1;
      for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as Node);
      step = outer;
      return;
    }
    if (node.type === 'paragraph' || node.type === 'heading') {
      const line: string[] = [];
      for (const child of node.content ?? []) {
        const inline = child as Inline;
        if (inline.type === 'text') line.push(inline.text ?? '');
        for (const mark of inline.marks ?? []) if (mark.type === 'link' && mark.attrs?.href) links.push(mark.attrs.href);
      }
      const text = line.join('');
      texts.push(text);
      if (step >= 0) stepNumbers[step]!.push(...numbersOf(text));
      return;
    }
    for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as Node);
  };
  for (const block of content.doc.blocks) walk(block as unknown as Node);
  return summarize(texts, links, stepNumbers, steps);
}

type Summary = { links: string[]; numbers: string[]; stepNumbers: string[][]; quotes: number; steps: number; findings: string[] };

/** Сводка для сверки по строкам текста: адреса в тексте, числа, кавычки, находки FR-SOL-04. links: адреса из разметки. */
function summarize(texts: readonly string[], links: string[], stepNumbers: string[][], steps: number): Summary {
  for (const text of texts) {
    for (const match of text.matchAll(URL_IN_TEXT)) links.push(match[0].replace(TRAILING, ''));
    const rest = text.replace(URL_IN_TEXT, ' ');
    for (const match of rest.matchAll(EMAIL_IN_TEXT)) links.push(match[0].toLowerCase());
    for (const match of rest.replace(EMAIL_IN_TEXT, ' ').matchAll(DOMAIN_IN_TEXT)) links.push(match[0].toLowerCase());
  }
  const numbers = texts.flatMap(numbersOf);
  const quotes = texts.reduce((sum, text) => sum + (text.match(QUOTED)?.length ?? 0), 0);
  // Находки проверки FR-SOL-04 (телефоны, почта, внутренние имена, серверы): перевод не приносит новых (M2s).
  const findings = texts.flatMap((text) => findInText(text).map((hit) => hit.text));
  return { links: links.sort(), numbers: numbers.sort(), stepNumbers: stepNumbers.map((list) => list.sort()), quotes, steps, findings };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Находки перевода, которых нет в оригинале (с учётом повторов). */
function extraFindings(original: readonly string[], translation: readonly string[]): string[] {
  const left = [...original];
  return translation.filter((text) => {
    const index = left.indexOf(text);
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

/**
 * Сверка перевода с оригиналом (поправка 101): те же адреса ссылок (и голые домены, и адреса почты), те же числа (и в
 * тех же шагах), столько же фрагментов в кавычках (названия экранов и кнопок; сам текст в кавычках переводится),
 * столько же шагов и ни одной находки проверки FR-SOL-04, которой нет в оригинале. Пусто: расхождений нет.
 */
export function compareInvariants(original: { title: string; doc: SolutionDoc }, translation: { title: string; doc: SolutionDoc }): InvariantIssue[] {
  return diffSummaries(collect(original), collect(translation));
}

/**
 * Та же сверка для простого текста без разметки (план M7, решение 11: заголовок и описание идеи): адреса в тексте,
 * числа, фрагменты в кавычках и находки FR-SOL-04 по строкам; шагов у простого текста нет.
 */
export function comparePlainInvariants(original: { title: string; body: string }, translation: { title: string; body: string }): InvariantIssue[] {
  const lines = (content: { title: string; body: string }) => [content.title, ...content.body.split(/\r?\n/)];
  return diffSummaries(summarize(lines(original), [], [], 0), summarize(lines(translation), [], [], 0));
}

function diffSummaries(a: Summary, b: Summary): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  if (!same(a.links, b.links)) issues.push({ kind: 'links', original: a.links, translation: b.links });
  if (!same(a.numbers, b.numbers)) issues.push({ kind: 'numbers', original: a.numbers, translation: b.numbers });
  else if (a.steps === b.steps && a.stepNumbers.some((list, i) => !same(list, b.stepNumbers[i] ?? []))) {
    const byStep = (lists: string[][]) => lists.map((list, i) => `${i + 1}: ${list.join(' ')}`.trim());
    issues.push({ kind: 'numbers', original: byStep(a.stepNumbers), translation: byStep(b.stepNumbers) });
  }
  if (a.quotes !== b.quotes) issues.push({ kind: 'quotes', original: [String(a.quotes)], translation: [String(b.quotes)] });
  if (a.steps !== b.steps) issues.push({ kind: 'steps', original: [String(a.steps)], translation: [String(b.steps)] });
  const extra = extraFindings(a.findings, b.findings);
  if (extra.length > 0) issues.push({ kind: 'data', original: [], translation: extra });
  return issues;
}
