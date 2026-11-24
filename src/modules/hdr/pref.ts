// Модуль hdr, слой pref: значения по умолчанию справочников (docs/naming.md, раздел 5).

/** Сроки по приоритету из раздела 7.4 ТЗ. Строка hdr_sla_policies действует вместо них (решение 0032). */
export const DEFAULT_SLA_POLICIES = {
  p1: { firstResponseMinutes: 15, resolutionMinutes: 180, resolutionDays: null, clock: 'business' },
  p2: { firstResponseMinutes: 60, resolutionMinutes: 480, resolutionDays: null, clock: 'business' },
  p3: { firstResponseMinutes: 240, resolutionMinutes: null, resolutionDays: 2, clock: 'business' },
  p4: { firstResponseMinutes: 480, resolutionMinutes: null, resolutionDays: 5, clock: 'business' },
} as const;

/** Рабочее время из раздела 7.4: Пн-Пт 08:00-20:00, Сб 09:00-17:00, Вс выходной, Asia/Tashkent. */
export const DEFAULT_TIMEZONE = 'Asia/Tashkent';
export const DEFAULT_WEEK = {
  0: null,
  1: ['08:00', '20:00'],
  2: ['08:00', '20:00'],
  3: ['08:00', '20:00'],
  4: ['08:00', '20:00'],
  5: ['08:00', '20:00'],
  6: ['09:00', '17:00'],
} as const;

/** Код календаря по умолчанию в hdr_business_calendars. */
export const DEFAULT_CALENDAR_CODE = 'default';

/**
 * Цвета тега (FR-AUTO-13, решение 8 плана M8): восемь кодов, за каждым стоят токены оформления (метки статусов,
 * "опасность" и основной цвет). В базе хранится код, а не значение цвета; классы токенов держит TagChip.
 */
export const TAG_COLORS = ['gray', 'green', 'orange', 'purple', 'blue', 'teal', 'red', 'accent'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
/** Цвет тега, созданного на обращении: перекрасить может администратор. */
export const TAG_DEFAULT_COLOR: TagColor = 'gray';
export const TAG_NAME_MAX = 40;
