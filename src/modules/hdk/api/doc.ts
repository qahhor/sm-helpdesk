// Документ решения для страниц: проверка схемой перед сохранением и отрисовкой (план M5, задачи 1 и 2).
// Вход модуля без обращения к базе: страницы берут у модуля только слой api (docs/naming.md, раздел 5).
export { parseSolutionDoc, safeParseSolutionDoc } from '../doc-schema';
export type { Block, SolutionDoc } from '../doc-schema';
export { solutionTemplate, type TemplateLabels } from '../template';
