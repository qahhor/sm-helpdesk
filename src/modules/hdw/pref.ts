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

/** Защита от зацикливания (FR-AUTO-07, решение 4 плана M8): столько срабатываний правила на обращении за окно, следующее выключает правило. */
export const LOOP_LIMIT = 10;
export const LOOP_WINDOW_MIN = 60;
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

/** Причина, по которой система выключила правило (ограничение hdw_rules_c5). */
export const DISABLED_REASONS = ['loop'] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];
