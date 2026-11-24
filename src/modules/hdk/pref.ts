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
