// Модуль hdi, слой pref: константы идей (docs/naming.md, раздел 5; план M7, решения 1-24).

/** Статусы идеи (FR-IDEA-08). */
export const IDEA_STATUSES = ['pending_review', 'open', 'shortlisted', 'selected', 'in_development', 'released', 'declined', 'merged'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** Опубликованные статусы: идею видят клиенты всех организаций (решение 2; у merged только при дате публикации). */
export const PUBLISHED_STATUSES = ['open', 'shortlisted', 'selected', 'in_development', 'released', 'merged'] as const satisfies readonly IdeaStatus[];
/** Голос и его отзыв принимаются только здесь (решение 4). */
export const VOTING_STATUSES = ['open', 'shortlisted'] as const satisfies readonly IdeaStatus[];
/** Цель объединения: идея не на модерации, не отклонена и не объединена (решение 6). */
export const MERGE_TARGET_STATUSES = ['open', 'shortlisted', 'selected', 'in_development', 'released'] as const satisfies readonly IdeaStatus[];

/** Кто переводит: moderator (product, admin и система) или только system (шорт-лист ставит и снимает отбор). */
export type TransitionBy = 'moderator' | 'system';

/**
 * Допустимые переходы статуса (решение 19). Тот же перечень держит функция базы app.hdi_idea_transition
 * (миграция 0079), тест ideas-writes сверяет их по всем парам.
 */
export const IDEA_TRANSITIONS: Readonly<Partial<Record<IdeaStatus, Partial<Record<IdeaStatus, TransitionBy>>>>> = {
  pending_review: { open: 'moderator', declined: 'moderator', merged: 'moderator' },
  open: { declined: 'moderator', merged: 'moderator', shortlisted: 'system' },
  shortlisted: { open: 'system', selected: 'moderator', declined: 'moderator' },
  selected: { in_development: 'moderator', declined: 'moderator' },
  in_development: { released: 'moderator', declined: 'moderator' },
};

/** Кто может перевести идею из from в to: moderator, system или null (переход запрещён). */
export function transitionBy(from: IdeaStatus, to: IdeaStatus): TransitionBy | null {
  return IDEA_TRANSITIONS[from]?.[to] ?? null;
}

/** Роли сотрудников, которые модерируют идеи, меняют статусы и выбирают идею месяца (решения 5, 17, 18). */
export const IDEA_MODERATOR_ROLES = ['product', 'admin'] as const;

export const IDEA_TRANSLATION_STATUSES = ['original', 'machine', 'reviewed', 'outdated', 'rejected'] as const;
export type IdeaTranslationStatus = (typeof IDEA_TRANSLATION_STATUSES)[number];

export const COMMENT_STATUSES = ['published', 'pending', 'hidden'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const CYCLE_STATUSES = ['open', 'decided', 'lapsed'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/** Способ подсчёта для доски и отбора (замечание к решению 5 ТЗ, решение 3 плана). */
export const VOTE_MODES = ['per_user', 'per_org'] as const;
export type VoteMode = (typeof VOTE_MODES)[number];
export const VOTE_MODE_SETTING = 'ideas.vote_mode';
export const VOTE_MODE_DEFAULT: VoteMode = 'per_user';

/** Пределы длины (решения 5, 8, 13). */
export const IDEA_TITLE_MAX = 120;
export const IDEA_BODY_MAX = 5000;
export const DECLINE_REASON_MAX = 1000;
export const COMMENT_MAX = 2000;
export const IDEA_NUMBER_MAX = 1_000_000_000;

/** Вложения идеи (решение 10): до трёх изображений по 5 МБ. */
export const IDEA_FILE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type IdeaFileMime = (typeof IDEA_FILE_MIMES)[number];
export const IDEA_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const IDEA_FILES_MAX = 3;
export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'rejected'] as const;
export type IdeaScanStatus = (typeof SCAN_STATUSES)[number];

/** Ключи хранилища: карантин до проверки, файлы организации после (как у вложений обращений, решение 0027). */
export const ideaQuarantineKey = (attachmentId: string): string => `quarantine/ideas/${attachmentId}`;
export const ideaStorageKey = (orgId: string, attachmentId: string): string => `files/ideas/${orgId}/${attachmentId}`;

/** Сколько слов нужно, чтобы форма спросила похожие идеи (решение 23). */
export const SIMILAR_MIN_WORDS = 3;
/** Сколько похожих идей показывает форма (решение 23). */
export const SIMILAR_LIMIT = 5;
/** Длина текста запроса похожих идей: длиннее обрезает страница. */
export const SIMILAR_QUERY_MAX = 500;

/** Находки, с которыми модератор публикует идею только после правки или отметки "Проверено" (решение 9). */
export const BLOCKING_FINDINGS = ['phone', 'email', 'inn', 'pinfl', 'server'] as const;

/** Показ номера идеи: I-204 (решение 1). */
export const ideaRef = (number: number): string => `I-${number}`;

/** Вкладки доски (FR-IDEA-14, решение 22). */
export const BOARD_TABS = ['popular', 'new', 'in_work', 'released'] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const BOARD_TAB_STATUSES: Readonly<Record<BoardTab, readonly IdeaStatus[]>> = {
  popular: ['open', 'shortlisted'],
  new: ['open', 'shortlisted'],
  in_work: ['selected', 'in_development'],
  released: ['released'],
};
/** Карточек на странице доски. */
export const BOARD_PAGE = 20;
/** Длина строки поиска по доске. */
export const BOARD_QUERY_MAX = 100;
