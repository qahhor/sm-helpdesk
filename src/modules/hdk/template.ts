import type { SolutionDoc } from './doc-schema';

// Заготовка нового решения (UX-W-01; план M5, задача 3, docs/decisions/0048-solution-editor.md). Три блока формы
// это три заголовка второго уровня в одном документе: "Что видит пользователь", "Почему так происходит", "Что сделать".
// Под первыми двумя пустой абзац, под третьим первый шаг. Сотрудник пишет под заголовками, шаги добавляет и
// переставляет в редакторе. Подписи заголовков на языке решения передаёт страница из messages/*.json.

export type TemplateLabels = { what: string; why: string; do: string };

/** Идентификаторы блоков заготовки: случайные, чтобы две заготовки не делили идентификаторы. */
export function solutionTemplate(labels: TemplateLabels, newId: () => string): SolutionDoc {
  const heading = (text: string) => ({
    type: 'heading' as const,
    attrs: { id: newId(), level: 2 as const },
    content: [{ type: 'text' as const, text }],
  });
  const paragraph = () => ({
    type: 'paragraph' as const,
    attrs: { id: newId() },
  });
  return {
    version: 1,
    blocks: [heading(labels.what), paragraph(), heading(labels.why), paragraph(), heading(labels.do), { type: 'step', attrs: { id: newId() }, content: [paragraph()] }],
  };
}
