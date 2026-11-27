import type { CodeLocation } from '../pref';

// Модуль hda, знания из кода: текст внутренней заметки анализа обращения по коду (веха M8c, задача 7; ТЗ 7.22
// FR-CODE-08; план M8c, решение 20). Чистая функция. Заметку собирает портал из полей ответа агента: гипотеза причины,
// уверенность, место в коде ссылкой, что проверить у клиента, вопросы клиенту, похожие обращения, рекомендация.
// Заголовки на русском, языке команды поддержки (как метки обезличивания M8b): это текст записи, а не интерфейс.
// Заметка показывается обычным текстом с пометкой "AI-сотрудник, не проверено".

export type AnalysisFields = {
  hypothesis: string;
  confidence: number;
  locations: readonly CodeLocation[];
  whatToCheck: readonly string[];
  questions: readonly string[];
  similarTickets: readonly number[];
  recommendation: string;
  entryKeys: readonly string[];
};

const location = (place: CodeLocation) => (place.line ? `${place.object}, ${place.path}:${place.line}` : `${place.object}, ${place.path}`);

export function analysisNoteText(fields: AnalysisFields): string {
  const parts: string[] = [];
  parts.push(`Гипотеза причины:\n${fields.hypothesis.trim()}`);
  parts.push(`Уверенность: ${Math.round(Math.min(1, Math.max(0, fields.confidence)) * 100)}%`);
  if (fields.locations.length > 0) parts.push(`Место в коде:\n${fields.locations.map((place) => `- ${location(place)}`).join('\n')}`);
  if (fields.whatToCheck.length > 0) parts.push(`Что проверить у клиента:\n${fields.whatToCheck.map((item, i) => `${i + 1}. ${item.trim()}`).join('\n')}`);
  if (fields.questions.length > 0) parts.push(`Вопросы клиенту:\n${fields.questions.map((item) => `- ${item.trim()}`).join('\n')}`);
  if (fields.similarTickets.length > 0) parts.push(`Похожие обращения: ${fields.similarTickets.map((n) => `SUP-${n}`).join(', ')}`);
  if (fields.recommendation.trim()) parts.push(`Рекомендация:\n${fields.recommendation.trim()}`);
  if (fields.entryKeys.length > 0) parts.push(`Записи каталога: ${fields.entryKeys.join(', ')}`);
  return parts.join('\n\n');
}
