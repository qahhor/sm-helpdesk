// Модуль hdk, слой pref: константы и коды знаний (docs/naming.md, раздел 5; план M5, задача 2).

/** Роли, которые создают и правят черновики решений (план M5, решение 10). product только читает. */
export const KB_WRITER_ROLES = ['agent_l1', 'agent_l2', 'care', 'admin'] as const;
/** Роли, которые публикуют и архивируют решения (FR-SOL-05). Четырёх глаз на этапе 1 нет. */
export const KB_PUBLISHER_ROLES = ['agent_l2', 'care', 'admin'] as const;

/** Вид статьи. На этапе 1 только решение (правка 3 раздела 10.6). */
export const ARTICLE_TYPES = ['solution'] as const;
export type ArticleType = (typeof ARTICLE_TYPES)[number];
/** Кому видна опубликованная статья. public появится на этапе 2 (правка 1 раздела 10.6). */
export const KB_AUDIENCES = ['internal', 'clients'] as const;
export type KbAudience = (typeof KB_AUDIENCES)[number];
export const ARTICLE_STATUSES = ['active', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];
export const VERSION_STATES = ['draft', 'published', 'superseded'] as const;
export type VersionState = (typeof VERSION_STATES)[number];
export const TRANSLATION_STATUSES = ['machine', 'reviewed', 'outdated'] as const;
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
export const FILE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FileMime = (typeof FILE_MIMES)[number];
/** Изображение решения до 10 МБ (решение 13). */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_SCAN_STATUSES = ['pending', 'clean', 'infected', 'rejected'] as const;
export type FileScanStatus = (typeof FILE_SCAN_STATUSES)[number];
export const SEARCH_KINDS = ['article', 'idea'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const DEFLECTION_OUTCOMES = ['helped', 'not_helped', 'ticket_created', 'left'] as const;
export type DeflectionOutcome = (typeof DEFLECTION_OUTCOMES)[number];
export const DEFLECTION_ZONES = ['portal', 'widget'] as const;
export type DeflectionZone = (typeof DEFLECTION_ZONES)[number];

/** Заголовок решения: до 200 знаков. */
export const TITLE_MAX = 200;
/** Самый большой номер статьи, который принимает ввод. */
export const ARTICLE_NUMBER_MAX = 999_999_999_999;

/** Автосохранение черновика раз в 5 секунд (UX-W-04). */
export const AUTOSAVE_INTERVAL_MS = 5000;
/** Предел длины метки версии строки: текст timestamptz из базы. */
export const REVISION_MAX = 64;
/** Статусы решения в списке /agent/solutions: черновик без публикации, опубликовано, в архиве. */
export const SOLUTION_LIST_STATUSES = ['draft', 'published', 'archived'] as const;
export type SolutionListStatus = (typeof SOLUTION_LIST_STATUSES)[number];
/** Сколько строк показывает список решений за раз. */
export const SOLUTION_LIST_LIMIT = 200;
/**
 * Список на пересмотр (FR-SOL-19, план M5, решение 18): доля "не помогло" выше 40% при не менее чем 10 исходах.
 * Тот же порог задача 11 покажет на странице показателей.
 */
export const REVIEW_MIN_OUTCOMES = 10;
export const REVIEW_NOT_HELPED_PERCENT = 40;
/** Ключи хранилища файлов решений: карантин до проверки и постоянное место (решение 16). */
export const fileQuarantineKey = (fileId: string): string => `quarantine/kb/${fileId}`;
export const fileStorageKey = (articleId: string, fileId: string): string => `files/kb/${articleId}/${fileId}`;
/** Настройка администратора: домены, на которые можно ссылаться из решения (FR-SOL-04). */
export const ALLOWED_DOMAINS_SETTING = 'kb.allowed_domains';
/** Сколько доменов принимает настройка. */
export const ALLOWED_DOMAINS_MAX = 50;
