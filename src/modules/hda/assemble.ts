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

/**
 * Заголовок и описание опубликованной идеи для перевода (ТЗ 14.3; план M7, решения 11, 12): только эти два поля,
 * внутри <idea>, после той же очистки, что у остальных целей: невидимые знаки, почта, телефоны и длинные числа, имя
 * автора и название его организации вырезаны. Комментариев, вложений, автора и организации в типе нет вовсе.
 */
export function assembleIdeaTranslationData(input: { from: string; to: string; title: string; body: string; redaction: { names: readonly string[]; orgTerms: readonly string[] } }): string {
  const terms = [...input.redaction.names.map((term) => ({ term, label: REDACTED.client })), ...orgRedactions(input.redaction.orgTerms, REDACTED.org)];
  const clean = (text: string) => escapeData(sanitizeForAi(redactTerms(scanText(text), terms)));
  return `Перевод с ${input.from} на ${input.to}\n<idea>\n<title>${clean(input.title)}</title>\n<body>${clip(clean(input.body), 12_000)}</body>\n</idea>`;
}

/**
 * Вход перевода публичного текста сотрудника (план M5c, решения 17, 24): известная проблема, рассылка, объявление.
 * Текст пишет сотрудник Smartup, данных клиентов в нём нет (его проверяет checkPublicText до сохранения); очистка
 * та же, что у идеи: невидимые знаки, почта и телефоны, разметка тега.
 */
export function assemblePublicTextData(input: { from: string; to: string; title: string; body: string }): string {
  const clean = (text: string) => escapeData(sanitizeForAi(scanText(text)));
  return `Перевод с ${input.from} на ${input.to}\n<public_text>\n<title>${clean(input.title)}</title>\n<body>${clip(clean(input.body), 12_000)}</body>\n</public_text>`;
}

/** Пределы входа первой линии (план M5b, решение 22; FR-AI-17): знаков. */
export const FIRST_LINE_LIMITS = { description: 5000, messages: 3000, solution: 1500, total: 8000 } as const;

export type FirstLineSolution = { id: string; title: string; text: string };

/** Последние знаки текста: длинная переписка теряет начало, а не последнее сообщение клиента. */
const tail = (text: string, max: number) => (text.length <= max ? text : text.slice(text.length - max));

/**
 * Вход модели первой линии и разбора (ТЗ 14.3, 11.12; план M5b, решение 22). В типе только разрешённое: тема,
 * описание и ответы клиента после ответа помощника (сообщений сотрудников, заметок и вложений нет вовсе) и до трёх
 * найденных опубликованных решений. Текст клиента очищен, как у черновика, и лежит внутри <ticket>; решения внутри
 * <solution id="...">, каждое до 1500 знаков. Описание до 5000 знаков, ответы клиента до 3000 (последние), всё
 * обращение до 8000.
 */
export function assembleFirstLineData(input: { title: string; description: string; clientMessages: readonly string[]; solutions: readonly FirstLineSolution[]; redaction: Redaction }): string {
  const L = FIRST_LINE_LIMITS;
  // Имя вырезается целиком и по словам: "Алишер Каримов" ловит и "Алишер".
  const split = (names: readonly string[]) => [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]))];
  const redaction: Redaction = { ...input.redaction, clientNames: split(input.redaction.clientNames), staffNames: split(input.redaction.staffNames) };
  const messages = tail(input.clientMessages.map((m) => cleanText(m, redaction)).join('\n'), L.messages);
  const lines = [
    `Тема: ${cleanText(input.title, redaction)}`,
    `Описание: ${clip(cleanText(input.description, redaction), L.description)}`,
    ...(messages ? [`Ответ клиента: ${messages}`] : []),
  ];
  const solutions = input.solutions.map((s) => `<solution id="${s.id}">\nЗаголовок: ${escapeData(sanitizeForAi(s.title))}\n${clip(escapeData(sanitizeForAi(s.text)), L.solution)}\n</solution>`);
  return `<ticket>\n${clip(lines.join('\n'), L.total)}\n</ticket>\n<solutions>\n${solutions.map((s) => `${s}\n`).join('')}</solutions>`;
}

/**
 * Одно сообщение клиента для перевода по кнопке "Перевести" (FR-AG-11) или определения благодарности (FR-TK-14):
 * только текст этого сообщения после очистки (перечень 14.3), до 3000 знаков. Тег message у перевода, reply у
 * благодарности.
 */
export function assembleMessageData(input: { tag: 'message' | 'reply'; to?: string; text: string; redaction: Redaction }): string {
  const split = (names: readonly string[]) => [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]))];
  const redaction: Redaction = { ...input.redaction, clientNames: split(input.redaction.clientNames), staffNames: split(input.redaction.staffNames) };
  const body = clip(cleanText(input.text, redaction), 3000);
  return `${input.to ? `Язык перевода: ${input.to}\n` : ''}<${input.tag}>\n${body}\n</${input.tag}>`;
}
