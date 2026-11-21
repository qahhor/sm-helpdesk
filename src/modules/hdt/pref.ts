// Модуль hdt (обращения), слой pref: константы и коды (docs/naming.md, раздел 5). Значения из ТЗ, раздел 7.2.

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

/** Сколько файлов можно приложить к одному сообщению (FR-TK-13). */
export const MAX_FILES_PER_MESSAGE = 10;

/** Срок повторного открытия закрытого обращения, дней (FR-TK-12). Меняется настройкой tickets.reopen_days. */
export const REOPEN_DAYS_DEFAULT = 14;
export const REOPEN_DAYS_SETTING = 'tickets.reopen_days';

/** Страница списка обращений. */
export const TICKET_PAGE_SIZE = 20;

/** Растровые картинки: только их можно показать миниатюрой (раздел 14.3: SVG и HTML всегда на скачивание). */
export const INLINE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
