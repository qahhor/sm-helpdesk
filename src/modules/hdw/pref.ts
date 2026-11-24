// Модуль hdw (автоматизация), слой pref: константы и коды правил (docs/naming.md, раздел 5; ТЗ 7.17; план M8, задача 3).

/** События, на которые можно повесить правило (FR-AUTO-02). */
export const RULE_EVENTS = ['ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed', 'rated', 'sla_soon', 'sla_breached', 'no_activity'] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];
/** Событие "AI передал обращение" названо в типе, но правило на него пока не сохраняется: данных нет до вехи M5b. */
export const RULE_EVENT_KINDS = [...RULE_EVENTS, 'ai_handoff'] as const;
export type RuleEventKind = (typeof RULE_EVENT_KINDS)[number];

/** Итог срабатывания (ограничение hdw_rule_runs_c1). */
export const RUN_RESULTS = ['applied', 'no_match', 'partial', 'failed', 'skipped_loop'] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

/**
 * Защита от зацикливания (FR-AUTO-07, решение 4 плана M8): столько срабатываний правила на обращении за окно,
 * следующее не выполняется (правило приостановлено на этом обращении, пока окно не освободится).
 */
export const LOOP_LIMIT = 10;
export const LOOP_WINDOW_MIN = 60;
/** Предел достигнут за окно на обращениях стольких разных организаций: правило выключается для всех. */
export const LOOP_ORGS_TO_DISABLE = 3;
/** Журнал срабатываний хранится столько суток, старше удаляет ночная очистка. */
export const RUNS_KEEP_DAYS = 90;
/** Пробный прогон берёт столько последних обращений (FR-AUTO-08, решение 6). */
export const DRY_RUN_TICKETS = 100;
/** Страница журнала срабатываний. */
export const RUNS_PAGE = 50;

/** Категория организации в условии: none значит "категория не задана". */
export const ORG_CATEGORIES = ['A', 'B', 'C', 'D', 'none'] as const;
export type OrgCategory = (typeof ORG_CATEGORIES)[number];

/** Кого можно уведомить по роли: роли людей (AI-сотрудники уведомлений не получают). */
export const NOTIFY_ROLES = ['agent_l1', 'agent_l2', 'care', 'product', 'admin'] as const;
export type NotifyRole = (typeof NOTIFY_ROLES)[number];

/**
 * Статусы, которые может поставить правило. "Новое" целью не бывает; "Решено" требует итога, который выбирает
 * сотрудник (FR-AG-09), поэтому правило его не ставит. Сам переход проверяется по таблице 7.2 в момент действия.
 */
export const RULE_STATUS_TARGETS = ['in_progress', 'waiting_customer', 'in_development', 'closed'] as const;
export type RuleStatusTarget = (typeof RULE_STATUS_TARGETS)[number];

/** Сотрудники линии для распределения по кругу: очередь обращения и роли её линии. */
export const LINE_ROLES = { l1: ['agent_l1'], l2: ['agent_l2'], care: ['care'] } as const;

export const RULE_NAME_MAX = 120;
export const RULE_NOTE_MAX = 2000;
export const MAX_CONDITIONS = 20;
export const MAX_ACTIONS = 10;
/** Условие "часов с последнего сообщения" и срок события "нет активности": до года. */
export const MAX_HOURS = 8760;
export const MAX_SNOOZE_HOURS = 720;

// --- Предустановленные правила (FR-AUTO-12; план M8, задача 10, решения 1 и 2) ---

/**
 * Действия только предустановленных правил: прежние встроенные уведомления портала с их получателями, шаблонами и
 * однократностью. Обычное правило и макрос их не принимают; значения у них нет.
 */
export const BUILTIN_ACTIONS = ['notify_oncall_p1', 'notify_sla_breach', 'notify_csat_low'] as const;
export type BuiltinAction = (typeof BUILTIN_ACTIONS)[number];

/** Кто получает уведомление о низкой оценке: сотрудники этой роли (план M8, "Что нужно от владельца"). */
export const CSAT_LOW_ROLE = 'care';

/** Причина, по которой система выключила правило (ограничение hdw_rules_c5). */
export const DISABLED_REASONS = ['loop'] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

// --- Исходящие вебхуки (FR-AUTO-10, FR-ADM-11; план M8, задача 5, решения 9-11) ---

/** Виды событий, на которые можно подписать адрес: события обращения из hdc_domain_events, у которых уже есть данные. */
export const WEBHOOK_EVENTS = ['ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed', 'rated', 'sla_soon', 'sla_breached'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Вид доставки: событие обращения, событие правила "нет активности" или проверочная отправка. */
export type DeliveryKind = RuleEventKind | 'test';
export const DELIVERY_STATUSES = ['queued', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Паузы перед повторами после неудачи, минут (решение 10): как у очереди исходящих. После шестой неудачи доставка получает failed. */
export const WEBHOOK_RETRY_MINUTES = [1, 5, 15, 60, 240] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_MINUTES.length + 1;
/** Приёмник отвечает не дольше этого. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** От одного адреса в одну пачку отправки берётся не больше стольких доставок: адрес с очередью не занимает пачку целиком. */
export const WEBHOOK_CLAIM_PER_ENDPOINT = 5;
/** В теле доставки не больше стольких тегов (предел тегов на обращении, MAX_TICKET_TAGS модуля обращений). */
export const WEBHOOK_BODY_MAX_TAGS = 20;
/** Тело доставки не длиннее этого, байт JSON: база держит 8000 байт текста jsonb, запас на его пробелы. */
export const WEBHOOK_BODY_BUDGET_BYTES = 7000;
/** Журнал доставок хранится столько суток. */
export const DELIVERIES_KEEP_DAYS = 30;
/** Страница журнала доставок. */
export const DELIVERIES_PAGE = 50;
export const WEBHOOK_NAME_MAX = 120;
export const WEBHOOK_URL_MAX = 2000;
/** Адресов в списке не больше этого: каждый подписанный адрес получает доставку на каждое событие. */
export const MAX_WEBHOOKS = 50;
/** Длина секрета подписи, байт. */
export const WEBHOOK_SECRET_BYTES = 32;

// --- Макросы (FR-AG-15, UX-A-16; план M8, задача 6) ---

export const MACRO_NAME_MAX = 120;
/** Очереди, между которыми сотрудник передаёт обращение сам: в Customer Care действия сотрудника нет. */
export const MACRO_QUEUES = ['l1', 'l2'] as const;
/** Действия, из которых собирается макрос: набор правил без вебхука, распределения по кругу и уведомления. */
export const MACRO_ACTIONS = ['set_queue', 'assign', 'set_priority', 'add_tag', 'remove_tag', 'add_note', 'reply_template', 'snooze', 'set_status'] as const;
/** Макросов в списке не больше этого: меню на странице обращения остаётся обозримым. */
export const MAX_MACROS = 50;
/** Итог запуска макроса: все действия выполнены, часть или ни одного. */
export type MacroResult = 'applied' | 'partial' | 'failed';

// --- Передача в разработку (FR-DEV-01..06; план M8, задачи 7 и 8, решения 12 и 13) ---

/** Режим работы с таск-менеджером: ручной (номер и ссылку вводит сотрудник) или API таск-менеджера Smartup. */
export const DEV_TRACKERS = ['manual', 'smartup'] as const;
export type DevTrackerKind = (typeof DEV_TRACKERS)[number];
/** Статусы задачи разработки (интерфейс DevTracker, ТЗ 11.11). */
export const DEV_TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type DevTaskStatus = (typeof DEV_TASK_STATUSES)[number];
/** Задача закрыта: исполнителям привязанных обращений уходит напоминание (FR-DEV-05). */
export const DEV_TASK_CLOSED: readonly DevTaskStatus[] = ['done', 'cancelled'];
export const DEV_TASK_REF_MAX = 80;
export const DEV_TASK_URL_MAX = 500;
export const DEV_TASK_TITLE_MAX = 300;
export const DEV_TASK_VERSION_MAX = 60;
