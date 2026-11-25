import type { Block, SolutionDoc } from './doc-schema';

// Черновик решения из ответа модели (ТЗ 11.10, FR-SOL-03; план M5, задача 7, решение 15). Чистая функция без базы.
// Модель возвращает только поля схемы 11.10 (заголовок, проблема, шаги, уверенность); документ собирает код. Ответ
// ложится в заготовку из трёх блоков формы (docs/decisions/0048, пункт 1): проблема под "Что видит пользователь",
// "Почему так происходит" остаётся пустым для сотрудника, шаги под "Что сделать". Текст модели становится только
// текстовыми узлами: ни ссылок, ни разметки, ни изображений модель в документ добавить не может.

export type DraftContent = { problem: string; steps: readonly string[] };

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const paragraph = (newId: () => string, text: string): Block => {
  const clean = text.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return { type: 'paragraph', attrs: { id: newId() }, ...(clean ? { content: [{ type: 'text', text: clean.slice(0, 10_000) }] } : {}) } as Block;
};

export function draftIntoTemplate(template: SolutionDoc, draft: DraftContent, newId: () => string): SolutionDoc {
  const problem = draft.problem.split(/\n\s*\n|\n/).map((part) => part.trim()).filter(Boolean);
  const problemBlocks = (problem.length > 0 ? problem : ['']).map((text) => paragraph(newId, text));
  const stepTexts = draft.steps.map((s) => s.trim()).filter(Boolean);
  const stepBlocks = (stepTexts.length > 0 ? stepTexts : ['']).map((text) => ({ type: 'step', attrs: { id: newId() }, content: [paragraph(newId, text)] }) as Block);
  const headings = template.blocks.map((block, index) => (block.type === 'heading' ? index : -1)).filter((index) => index >= 0);
  if (headings.length < 3) return { version: 1, blocks: [...problemBlocks, ...stepBlocks] };
  const [what, why, todo] = headings as [number, number, number];
  return {
    version: 1,
    blocks: [template.blocks[what]!, ...problemBlocks, ...template.blocks.slice(why, todo + 1), ...stepBlocks],
  };
}
