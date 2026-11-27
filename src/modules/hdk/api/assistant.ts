import 'server-only';
import type { ClientActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { compareInvariants, textSegments } from '../translation';
import { type PublishedSolution, readPublishedSolution } from './articles';

// Модуль hdk, слой api: решения для помощника первой линии (план M5b, задача 4, решения 7 и 9; FR-AI-02, FR-AI-12).
// Читает только hdk_published и только от имени клиента-автора обращения: политика отдаёт ему решения с аудиторией
// clients, внутреннее ("только через сотрудника") для него не существует. Машинный перевод годится в ответ, только если
// ссылки, числа, фрагменты в кавычках и число шагов совпадают с оригиналом.

export type AssistantSolution = {
  articleId: string;
  number: number;
  locale: Locale;
  title: string;
  /** Текст документа кусками по порядку: вход модели (до 1500 знаков обрежет сборщик входа). */
  text: string;
  isMachine: boolean;
  /** Машинный перевод совпал с оригиналом по инвариантам (или это не машинный перевод). */
  invariantsOk: boolean;
};

const plainText = (solution: PublishedSolution) => textSegments(solution.doc).map((s) => s.text).join('\n');

export async function assistantSolution(actor: ClientActor, input: { number: number; locale: Locale }): Promise<AssistantSolution | null> {
  const ctx = { actor };
  const solution = await readPublishedSolution(ctx, { number: input.number, locale: input.locale });
  if (!solution) return null;
  let invariantsOk = true;
  if (solution.isMachine) {
    const original = await readPublishedSolution(ctx, { number: input.number, locale: solution.originalLocale });
    invariantsOk = original !== null && compareInvariants({ title: original.title, doc: original.doc }, { title: solution.title, doc: solution.doc }).length === 0;
  }
  return { articleId: solution.articleId, number: solution.number, locale: solution.locale, title: solution.title, text: plainText(solution), isMachine: solution.isMachine, invariantsOk };
}
