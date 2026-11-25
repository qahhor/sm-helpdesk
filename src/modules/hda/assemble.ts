import { scanText } from '@/modules/hdc/pref';
import { clip, escapeData, orgRedactions, REDACTED, redactTerms, sanitizeForAi } from './util';

// Модуль hda: сборка данных для модели из разрешённых полей (ТЗ 14.3, 11.10, поправка 101; план M5, задача 5).
// Функции принимают только то, что разрешено отправлять: публичные сообщения закрытого обращения (черновик) и
// тексты решения (перевод). Внутренних заметок, вложений, адресов и названий в типах нет вовсе: их нельзя передать
// по ошибке. Имена участников и название организации приходят отдельно и только затем, чтобы их вырезать.
// Данные лежат внутри тегов и экранированы: модель получает их как данные, а не как инструкции.

export type DraftMessage = { role: 'client' | 'staff'; body: string };
/** Что вырезать: имена людей (меткой роли) и название, ИНН организации. */
export type Redaction = { clientNames: readonly string[]; staffNames: readonly string[]; orgTerms: readonly string[] };

function cleanText(text: string, redaction: Redaction): string {
  const terms = [
    ...redaction.clientNames.map((term) => ({ term, label: REDACTED.client })),
    ...redaction.staffNames.map((term) => ({ term, label: REDACTED.staff })),
    // Название целиком и каждое значимое слово по основе: "Ромашке" вместо "Ромашка" тоже вырезается (0057, I3s).
    ...orgRedactions(redaction.orgTerms, REDACTED.org),
  ];
  // Сначала та же нормализация, что у sanitizeForAi: имя с невидимым соединителем внутри не уходит мимо замены.
  return escapeData(sanitizeForAi(redactTerms(scanText(text), terms)));
}

/**
 * Переписка закрытого обращения для черновика (ТЗ 11.10): язык ответа и текст внутри <ticket>. Автор каждого
 * сообщения назван ролью "Клиент" или "Сотрудник", а не именем (решение 15).
 */
export function assembleDraftData(input: { locale: string; title: string; description: string; messages: readonly DraftMessage[]; redaction: Redaction }): string {
  const lines = [
    `${REDACTED.client}: ${cleanText(input.title, input.redaction)}`,
    `${REDACTED.client}: ${cleanText(input.description, input.redaction)}`,
    ...input.messages.map((m) => `${m.role === 'client' ? REDACTED.client : REDACTED.staff}: ${cleanText(m.body, input.redaction)}`),
  ];
  return `Язык ответа: ${input.locale}\n<ticket>\n${clip(lines.join('\n\n'))}\n</ticket>`;
}

export type TranslationSegment = { id: string; text: string };

/**
 * Текст решения для перевода: заголовок и куски текста документа с идентификаторами внутри <solution>. Адреса ссылок
 * в модель не уходят: их ставит код из оригинала (поправка 101).
 */
export function assembleTranslationData(input: { from: string; to: string; segments: readonly TranslationSegment[] }): string {
  const body = input.segments.map((s) => `<segment id="${s.id}">${escapeData(sanitizeForAi(s.text))}</segment>`).join('\n');
  return `Перевод с ${input.from} на ${input.to}\n<solution>\n${clip(body, 40_000)}\n</solution>`;
}
