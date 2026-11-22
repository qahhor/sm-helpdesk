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

export const EVENT_KINDS = ['created', 'status', 'visibility', 'rated', 'priority', 'assignee', 'queue', 'due', 'rule', 'merge', 'type', 'module', 'snooze', 'bound'] as const;
/** События, которые клиент может видеть. Остальные база принимает только внутренними (миграция 0021). */
export const CLIENT_VISIBLE_EVENT_KINDS: readonly EventKind[] = ['created', 'status', 'visibility', 'rated', 'merge'];
/** Кто из сотрудников ведёт обращения: product только читает (ТЗ 5.2). */
export const STAFF_WRITE_ROLES = ['agent_l1', 'agent_l2', 'care', 'admin'] as const;
/** Кто ставит "В разработке" и возвращает обращение на первую линию (ТЗ 5.2, FR-LINE-04). */
export const DEVELOPMENT_ROLES = ['agent_l2', 'care', 'admin'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Переходы, которые сотрудник с этой ролью может сделать из статуса: таблица 7.2 за вычетом чужих прав.
 * Закрывает сотрудник только решённое (решение 5 плана M3): "Ждём вашего ответа" закрывает задача по молчанию.
 * Объединённое обращение закрыто навсегда (решение 4).
 */
export function allowedStaffTransitions(from: TicketStatus, role: string, opts: { merged?: boolean } = {}): TicketStatus[] {
  if (opts.merged || !(STAFF_WRITE_ROLES as readonly string[]).includes(role)) return [];
  const development = (DEVELOPMENT_ROLES as readonly string[]).includes(role);
  return TRANSITIONS[from].filter((to) => (to !== 'in_development' || development) && (to !== 'closed' || from === 'resolved'));
}

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

const RASTER: readonly DetectedType[] = ['png', 'jpeg', 'gif', 'webp'];

/**
 * Какие настоящие типы допустимы для заявленного (угроза T6, решение 0027). Офисные файлы нового формата и
 * OpenDocument это ZIP, старые doc, xls, ppt это OLE, тексты без нулевых байтов или в UTF-16 с меткой. Документ
 * нового формата с паролем лежит в контейнере OLE и не принимается: его нельзя проверить (пункт 20). Картинка с
 * чужим расширением (PNG в файле .jpg) принимается: это та же растровая картинка, в строку записывается её
 * настоящий тип. HTML, SVG и исполняемые файлы не допустимы нигде.
 */
export const ACCEPTED_TYPES: Readonly<Record<string, readonly DetectedType[]>> = {
  'image/png': RASTER,
  'image/jpeg': RASTER,
  'image/gif': RASTER,
  'image/webp': RASTER,
  'image/heic': ['heic'],
  'application/pdf': ['pdf'],
  'application/msword': ['ole'],
  'application/vnd.ms-excel': ['ole'],
  'application/vnd.ms-powerpoint': ['ole'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['zip'],
  'application/vnd.oasis.opendocument.text': ['zip'],
  'application/vnd.oasis.opendocument.spreadsheet': ['zip'],
  'application/vnd.oasis.opendocument.presentation': ['zip'],
  'application/zip': ['zip'],
  'text/plain': ['text'],
  'text/csv': ['text'],
  'application/json': ['text'],
  'application/xml': ['text'],
  'video/mp4': ['mp4'],
};

/**
 * Почему файл не принят, если причину можно назвать клиенту (решение 0027, пункт 20): зашифрован (архив или
 * документ с паролем) или превышает пределы проверки (вложенность, число файлов, размер после распаковки).
 */
export type RejectReason = 'encrypted' | 'limits';

/** Подпись отказа для документа Office нового формата в контейнере OLE: так хранится документ с паролем. */
export const ENCRYPTED_OFFICE_SIGNATURE = 'encrypted_office';

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

/** Сколько строк берёт один проход обхода загрузок: остальное возьмёт следующий через минуту. */
export const SWEEP_BATCH = 200;

/** Итог при решении (FR-AG-09): решено, обходной путь, не воспроизводится, дубль, работает как задумано, исправлено в версии. */
/** Присутствие на странице обращения (FR-AG-12): открыл или печатает. Отметка раз в 10 секунд, живёт 60 (решение 10). */
export const PRESENCE_MODES = ['viewing', 'typing'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];
export const PRESENCE_TTL_SEC = 60;
export const PRESENCE_TOUCH_SEC = 10;

/** Причины передачи на вторую линию (FR-LINE-03, решение 3 плана M3, подтверждено владельцем). */
export const TRANSFER_REASONS = ['needs_client_data', 'suspected_bug', 'client_configuration', 'data_fix', 'not_in_playbook', 'other'] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
/** Срок "взять в работу" для второй линии по приоритету, рабочих минут (FR-LINE-06): {"p1": 30}. Нет: срок первого ответа. */
export const PICKUP_SETTING = 'lines.pickup_minutes';
/** Из каких статусов первая линия передаёт обращение на вторую. */
export const TRANSFERABLE_STATUSES: readonly TicketStatus[] = ['new', 'in_progress', 'waiting_customer'];

export const RESOLUTION_TYPES = ['solved', 'workaround', 'not_reproducible', 'duplicate', 'by_design', 'fixed_in_version'] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

/** Дальше этого обращение не откладывается: отложение не заменяет закрытие. */
export const MAX_SNOOZE_DAYS = 365;

/**
 * Сроки напоминания и автозакрытия в рабочих днях (FR-TK-10, FR-TK-15, решение 24 вехи M4): настройки
 * администратора в hdc_settings, по умолчанию значения ТЗ.
 */
export const WAITING_REMINDER_SETTING = 'notify.waiting_reminder_days';
export const AUTOCLOSE_RESOLVED_SETTING = 'tickets.autoclose_resolved_days';
export const AUTOCLOSE_WAITING_SETTING = 'tickets.autoclose_waiting_days';
/** Регулярное обновление клиента по обращению "В разработке" (FR-SLA-09): не реже раза в столько рабочих дней. */
export const UPDATE_DUE_SETTING = 'sla.update_interval_days';
export const DAY_SETTINGS_DEFAULT = {
  [WAITING_REMINDER_SETTING]: 3,
  [AUTOCLOSE_RESOLVED_SETTING]: 5,
  [AUTOCLOSE_WAITING_SETTING]: 7,
  [UPDATE_DUE_SETTING]: 5,
} as const;
/** Допустимые значения сроков в рабочих днях. */
export const DAY_SETTING_MIN = 1;
export const DAY_SETTING_MAX = 30;
