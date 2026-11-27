import * as z from 'zod';
import { HANDOFF_QUESTION_IDS, INTRO_TEMPLATE_IDS } from '../pref';

// Модуль hda: ответ модели первой линии (ТЗ 11.12; план M5b, задача 4). Структура фиксированного вида с
// идентификаторами: своего текста клиенту модель не пишет. Резюме и заголовок видит только сотрудник (задача 7).
// Флаги модели только добавляют передачу, но не отменяют её; выбор решения код сверяет с найденными.

export const firstLineOutput = z.object({
  triage: z.object({
    // Длину кода, заголовка и резюме проверяет код при записи (saveTriage, safeTriageTitle): длинный заголовок не
    // предлагается, резюме обрезается. Предел в схеме отменял бы верный ответ клиенту (независимая проверка M5b, I4).
    moduleCode: z.string().nullable(),
    type: z.enum(['bug', 'question', 'service_request']).nullable(),
    title: z.string(),
    summary: z.string(),
    looksMoreSevere: z.boolean(),
  }),
  action: z.enum(['answer', 'clarify', 'handoff']),
  solutionId: z.uuid().nullable(),
  introId: z.enum(INTRO_TEMPLATE_IDS),
  clarifyBetween: z.array(z.uuid()).length(2).nullable(),
  questionIds: z.array(z.enum(HANDOFF_QUESTION_IDS)).max(3),
  restrictedTopic: z.boolean(),
  customerAsksHuman: z.boolean(),
});
export type FirstLineOutput = z.infer<typeof firstLineOutput>;
