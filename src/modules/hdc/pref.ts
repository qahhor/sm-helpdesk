// Модуль hdc, слой pref: константы и коды (docs/naming.md, раздел 5).

/**
 * Действия журнала аудита. Закрытый перечень: запись с другим действием отклоняется.
 * Каждая веха добавляет сюда свои действия.
 */
export const AUDIT_ACTIONS = [
  // Сотрудники
  'staff.invited',
  'staff.created',
  'staff.reset',
  'staff.signed_in',
  // Реестр серверов Smartup
  'server.added',
  'server.disabled',
  'server.enabled',
  'server.updated',
  // Организации и участники
  'org.provisioned',
  'member.joined',
  'member.role_changed',
  'member.state_changed',
  // Приглашения
  'invitation.created',
  'invitation.revoked',
  'invitation.accepted',
  // Учётная запись и сессии
  'user.email_confirmed',
  'session.revoked',
  // Каналы связи
  'telegram.linked',
  'telegram.unlinked',
  'user.signed_in_telegram',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type RateRule = { limit: number; windowSec: number };

/**
 * Пределы частоты. Первые три заданы разделом 14.5 ТЗ, остальные приняты в вехе M1
 * (docs/decisions/0014-identity-access.md).
 */
export const RATE_RULES = {
  /** Запрос ссылки для входа: 5 в час на адрес. */
  loginLinkPerAddress: { limit: 5, windowSec: 3600 },
  /** Запрос ссылки для входа: 20 в час на IP. */
  loginLinkPerIp: { limit: 20, windowSec: 3600 },
  /** Попытка входа сотрудника: 10 в 15 минут на учётную запись, затем блокировка на 15 минут. */
  staffLoginPerAccount: { limit: 10, windowSec: 900 },
  /** Поиск сервера Smartup по адресу на странице входа. */
  serverLookupPerIp: { limit: 20, windowSec: 3600 },
  /** Запрос подтверждения email. */
  emailConfirmPerUser: { limit: 5, windowSec: 3600 },
  /** Приглашения в одну организацию. */
  invitationsPerOrg: { limit: 20, windowSec: 3600 },
  /** Ссылки привязки Telegram на пользователя (решение 0018). */
  telegramLinkPerUser: { limit: 5, windowSec: 3600 },
  /** Ссылки входа из бота на аккаунт Telegram (раздел 14.5 ТЗ). */
  loginLinkPerTelegram: { limit: 5, windowSec: 3600 },
  /** Начало входа через Smartup: каждое начало оставляет в базе одноразовое значение состояния. */
  ssoStartPerIp: { limit: 30, windowSec: 600 },
  /** Возврат с сервера Smartup на единственный открытый адрес библиотеки входа. */
  ssoCallbackPerIp: { limit: 60, windowSec: 60 },
} as const satisfies Record<string, RateRule>;
