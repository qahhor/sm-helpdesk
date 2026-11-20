// Модуль hdu, слой pref: константы и коды идентичности (docs/naming.md, раздел 5; ТЗ, раздел 5).

/** Роли клиента в организации. */
export const CLIENT_ROLES = ['client_user', 'client_admin'] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

/** Роли сотрудников Smartup. */
export const STAFF_ROLES = ['agent_l1', 'agent_l2', 'care', 'product', 'admin', 'agent_bot'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Роли людей: AI-сотрудник (agent_bot) в рабочее место не входит и приглашением не заводится. */
export const HUMAN_STAFF_ROLES = ['agent_l1', 'agent_l2', 'care', 'product', 'admin'] as const;
export type HumanStaffRole = (typeof HUMAN_STAFF_ROLES)[number];

/**
 * Откуда членство: вход через Smartup, приглашение администратора клиента, приглашение сотрудника,
 * письмо с неизвестного адреса (гость, входа не даёт).
 */
export const MEMBERSHIP_SOURCES = ['smartup', 'invite', 'staff', 'guest'] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

export const RECORD_STATES = ['active', 'passive'] as const;
export type RecordState = (typeof RECORD_STATES)[number];
