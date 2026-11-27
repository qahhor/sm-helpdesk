// Модуль hdp, слой pref: константы известных проблем, рассылок и объявлений (docs/naming.md, раздел 5; план M5c).

/** Статусы известной проблемы (FR-KP-02): изучаем, причина найдена, исправляем, исправлено, закрыто. */
export const PROBLEM_STATUSES = ['investigating', 'cause_found', 'fixing', 'fixed', 'closed'] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/**
 * Активные статусы (решение 7): проблема притягивает новые обращения по сигнатуре и показывается баннером. Исправленная
 * и закрытая не активны: та же ошибка после исправления может быть новым сбоем. Тот же перечень держит база
 * (app.hdp_problem_signatures_active, миграция 0098).
 */
export const ACTIVE_PROBLEM_STATUSES = ['investigating', 'cause_found', 'fixing'] as const satisfies readonly ProblemStatus[];
export const isActiveProblem = (status: ProblemStatus): boolean => (ACTIVE_PROBLEM_STATUSES as readonly string[]).includes(status);

/** Статусы, которые сотрудник ставит на карточке. Закрытие идёт только окном закрытия с итоговым текстом (решение 20). */
export const SETTABLE_PROBLEM_STATUSES = ['investigating', 'cause_found', 'fixing', 'fixed'] as const satisfies readonly ProblemStatus[];

/** Роли, которые создают, ведут, рассылают и закрывают проблемы (FR-KP-03, решение 3). Тот же перечень: app.hdp_can_write. */
export const PROBLEM_WRITER_ROLES = ['agent_l2', 'care', 'admin'] as const;

/** Пределы длины текстов (миграция 0098). */
export const PROBLEM_TITLE_MAX = 200;
export const PROBLEM_BODY_MAX = 5000;
export const PROBLEM_NUMBER_MAX = 1_000_000_000;

/** Исправленная проблема видна клиентам на странице проблем столько суток (FR-KP-09). */
export const FIXED_SHOWN_DAYS = 30;

/** Рассылка (решения 17, 18, 20): обновление или итог закрытия; черновик окна подтверждения, подтверждена, идёт, разослана. */
export const BROADCAST_KINDS = ['update', 'closing'] as const;
export type BroadcastKind = (typeof BROADCAST_KINDS)[number];
export const BROADCAST_STATUSES = ['draft', 'queued', 'sending', 'done'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];
/** Получатели рассылки: привязанные обращения в этих статусах (решение 17). */
export const BROADCAST_TICKET_STATUSES = ['new', 'in_progress', 'waiting_customer', 'in_development'] as const;
export const BROADCAST_BODY_MAX = 5000;

/** Объявления (FR-ANN-01, решение 24): виды, аудитории, предел периода показа. */
export const ANNOUNCEMENT_KINDS = ['maintenance', 'outage', 'news'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];
export const ANNOUNCEMENT_AUDIENCES = ['all', 'server', 'module'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
/** Кто пишет объявления (FR-ANN-01). Тот же перечень: app.hdp_can_announce. */
export const ANNOUNCEMENT_WRITER_ROLES = ['care', 'admin'] as const;
export const ANNOUNCEMENT_MAX_DAYS = 90;
export const ANNOUNCEMENT_ARCHIVE_DAYS = 90;
export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_BODY_MAX = 3000;
/** Где показывается баннер: главная и страницы портала, форма нового обращения, панель виджета. */
export const ANNOUNCEMENT_SURFACES = ['portal', 'form', 'widget'] as const;
export type AnnouncementSurface = (typeof ANNOUNCEMENT_SURFACES)[number];
