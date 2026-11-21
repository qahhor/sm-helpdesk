// Модуль hdt (обращения), слой pref: константы и коды (docs/naming.md, раздел 5). Значения из ТЗ, раздел 7.2.

import type { DetectedType } from '@/modules/hdc/api';

/** Тип обращения (FR-TK-01). */
export const TICKET_TYPES = ['bug', 'question', 'service_request'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Влияние на работу (FR-TK-03): "Работа остановлена", "Серьёзно мешает", "Неудобство", "Вопрос". */
export const IMPACTS = ['blocker', 'major', 'minor', 'question'] as const;
export type Impact = (typeof IMPACTS)[number];

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Предварительный приоритет из влияния (FR-TK-03). */
export const PRIORITY_BY_IMPACT: Record<Impact, Priority> = { blocker: 'p1', major: 'p2', minor: 'p3', question: 'p4' };

/** Статусы обращения (раздел 7.2). */
export const TICKET_STATUSES = ['new', 'in_progress', 'waiting_customer', 'in_development', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Разрешённые переходы статуса (раздел 7.2). Любой другой переход сервис отклоняет. */
export const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ['in_progress', 'waiting_customer'],
  in_progress: ['waiting_customer', 'in_development', 'resolved'],
  waiting_customer: ['in_progress', 'resolved', 'closed'],
  in_development: ['in_progress', 'resolved'],
  resolved: ['closed', 'in_progress'],
  closed: ['in_progress'],
};

export const canTransition = (from: TicketStatus, to: TicketStatus): boolean => TRANSITIONS[from].includes(to);

/** Видимость (FR-TK-04): вся организация или только автор (и администратор клиента). */
export const VISIBILITIES = ['org', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const QUEUES = ['l1', 'l2', 'care'] as const;
export type Queue = (typeof QUEUES)[number];

/** Откуда пришло обращение. Перечень только в коде (раздел 10.2). */
export const TICKET_SOURCES = ['portal', 'widget_web', 'widget_mobile', 'email', 'staff'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const AUTHOR_TYPES = ['client', 'staff', 'system', 'ai', 'agent'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const EVENT_KINDS = ['created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const WATCHER_SOURCES = ['author', 'manual', 'staff'] as const;
export type WatcherSource = (typeof WATCHER_SOURCES)[number];

/** Проверка вложения: rejected значит настоящий тип не совпал с заявленным или запрещён (решение 0027). */
export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'rejected'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** Причины низкой оценки (FR-TK-11, решение 0026). */
export const CSAT_REASONS = ['slow', 'not_solved', 'unclear', 'other'] as const;
export type CsatReason = (typeof CSAT_REASONS)[number];

/** Какие загрузки можно прикрепить к сообщению: отклонённые и заражённые нельзя (решение 0027). */
export const ATTACHABLE_SCAN_STATUSES: readonly ScanStatus[] = ['pending', 'clean'];

/** Сколько файлов можно приложить к одному сообщению (FR-TK-13). */
export const MAX_FILES_PER_MESSAGE = 10;

/**
 * Разрешённые файлы (FR-TK-13): расширение и тип, который хранится в строке и подписывается в ссылке.
 * SVG и HTML не принимаются никогда (раздел 14.3).
 */
export const ALLOWED_FILES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  mp4: 'video/mp4',
};

/**
 * Типы, которые браузеры и системы присылают для тех же файлов (решение 0027). Они принимаются, но в строку
 * и подпись идёт тип из ALLOWED_FILES. Пустой тип и application/octet-stream принимаются для любого расширения.
 */
export const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  jpg: ['image/pjpeg'],
  jpeg: ['image/pjpeg'],
  heic: ['image/heif'],
  csv: ['application/vnd.ms-excel', 'application/csv', 'text/x-csv', 'text/comma-separated-values'],
  log: ['text/x-log'],
  json: ['text/json'],
  xml: ['text/xml'],
  zip: ['application/x-zip-compressed', 'application/x-zip'],
};

/**
 * Какой настоящий тип ожидается у файла заявленного типа (угроза T6, решение 0027). Офисные файлы нового
 * формата и OpenDocument это ZIP, старые doc, xls, ppt это OLE, тексты без нулевых байтов.
 */
export const DETECTED_BY_MIME: Readonly<Record<string, DetectedType>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/msword': 'ole',
  'application/vnd.ms-excel': 'ole',
  'application/vnd.ms-powerpoint': 'ole',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'zip',
  'application/vnd.oasis.opendocument.text': 'zip',
  'application/vnd.oasis.opendocument.spreadsheet': 'zip',
  'application/vnd.oasis.opendocument.presentation': 'zip',
  'application/zip': 'zip',
  'text/plain': 'text',
  'text/csv': 'text',
  'application/json': 'text',
  'application/xml': 'text',
  'video/mp4': 'mp4',
};

/** Предел размера файла (FR-TK-13): 25 МБ, видео MP4 до 50 МБ. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Срок повторного открытия закрытого обращения, дней (FR-TK-12). Меняется настройкой tickets.reopen_days. */
export const REOPEN_DAYS_DEFAULT = 14;
export const REOPEN_DAYS_SETTING = 'tickets.reopen_days';

/** Страница списка обращений. */
export const TICKET_PAGE_SIZE = 20;

/** Растровые картинки: только их можно показать миниатюрой (раздел 14.3: SVG и HTML всегда на скачивание). */
export const INLINE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
