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

/** Сессия клиента: 30 дней с продлением при активности (FR-ID-10). Без активности 30 суток выход (ASVS 7.3.1). */
export const SESSION_TTL_SEC = 30 * 24 * 3600;
/**
 * Сессия клиента живёт не дольше 90 суток от входа, сколько бы человек ни работал (ASVS 7.3.2;
 * ответ владельца 26.11.2026, решение 0067). Продление при активности этот предел не сдвигает.
 */
export const CLIENT_SESSION_MAX_SEC = 90 * 24 * 3600;
/** Приставка имён кук библиотеки входа: кука сессии hub.session_token, на https __Host-hub.session_token. */
export const AUTH_COOKIE_PREFIX = 'hub';
/** Куки библиотеки входа и её дополнений, которым на https задаётся имя с приставкой __Host- (решение 0021). */
export const AUTH_COOKIE_NAMES = ['session_token', 'session_data', 'dont_remember', 'account_data', 'state', 'oauth_state', 'two_factor', 'trust_device'] as const;
/** Как часто библиотека продлевает сессию при активности. */
export const SESSION_UPDATE_AGE_SEC = 24 * 3600;
/** Сессия сотрудника: 12 часов без продления (FR-ID-10). */
export const STAFF_SESSION_TTL_SEC = 12 * 3600;
/** Приглашение сотрудника и ссылка после сброса живут 24 часа (решение 0015): ссылка даёт права в рабочем месте. */
export const STAFF_INVITATION_TTL_SEC = 24 * 3600;
/** Ссылка запасного входа из бота Telegram: 10 минут (FR-ID-14, решение 94 ТЗ). */
export const LOGIN_BOT_LINK_TTL_SEC = 10 * 60;
/** Ссылка для входа на email: 15 минут (FR-ID-05). */
export const LOGIN_LINK_TTL_SEC = 15 * 60;
/** Ссылка подтверждения email живёт час (письмо называет этот срок, тест сверяет). */
export const EMAIL_TOKEN_TTL_SEC = 60 * 60;
/** Приглашение в организацию живёт 7 дней (FR-ID-08). */
export const INVITATION_TTL_SEC = 7 * 24 * 3600;
/** Сколько приглашений показывает список организации: новые первыми. */
export const INVITATIONS_LIST_LIMIT = 100;
/** Код второго фактора: 5 неверных попыток, затем блокировка на 15 минут (ТЗ 14.5). */
export const TOTP_MAX_FAILED_ATTEMPTS = 5;
export const TOTP_LOCK_SEC = 15 * 60;

/**
 * Поля сведений о пользователе, которые портал ждёт от Smartup: наше имя и имя поля в ответе сервера.
 * Что именно приходит в company_id (компания или организация из переключателя Smartup), уточняется:
 * вопрос 43 ТЗ. Ответ меняет только эту таблицу.
 */
export const SMARTUP_CLAIMS = {
  companyId: 'company_id',
  companyName: 'company_name',
  inn: 'inn',
  role: 'role',
  locale: 'locale',
  // Своё имя поля: поле email в сведениях библиотека заполняет идентификатором пользователя (решение 0013).
  contactEmail: 'email',
} as const;

// --- Виджет (план M6, решения 2, 4, 6 и 16) ---

/** Чем сервер Smartup подписывает токен контекста: ключи по адресу JWKS или общий секрет (решение 2). */
export const CONTEXT_KEY_MODES = ['jwks', 'secret'] as const;
export type ContextKeyMode = (typeof CONTEXT_KEY_MODES)[number];

/**
 * Допустимые алгоритмы подписи токена контекста по режиму. Режим задаёт их жёстко: HS256 у сервера jwks (открытый ключ
 * вместо секрета) и alg none отклоняются при любом заголовке токена (подмена алгоритма).
 */
export const CONTEXT_ALGORITHMS = { jwks: ['ES256', 'EdDSA', 'RS256'], secret: ['HS256'] } as const satisfies Record<ContextKeyMode, readonly string[]>;

/** Получатель токена контекста (aud), ТЗ 11.4. */
export const CONTEXT_AUDIENCE = 'smartup-hub';
/** Наибольший срок токена контекста (exp - iat) и допуск часов, секунды (решение 4). */
export const CONTEXT_MAX_TTL_SEC = 300;
export const CONTEXT_CLOCK_TOLERANCE_SEC = 60;
/** Платформы токена контекста (ТЗ 11.4). */
export const CONTEXT_PLATFORMS = ['web', 'android', 'ios'] as const;
export type ContextPlatform = (typeof CONTEXT_PLATFORMS)[number];

/** Дополнительных адресов встраивания у сервера не больше пяти (решение 6). */
export const EMBED_ORIGINS_MAX = 5;
/** Ключ встраивания: 32 шестнадцатеричных знака (128 бит), как в hdu_servers_c15. */
export const EMBED_KEY_PATTERN = /^[0-9a-f]{32}$/;

/** Токен виджета (решение 16): получатель и срок. */
export const EMBED_AUDIENCE = 'hub-embed';
export const EMBED_TOKEN_TTL_SEC = 15 * 60;

/** Образец кода сервера Smartup. Тот же, что в ограничении таблицы hdu_servers. */
export const SERVER_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Проблемы, которые находит проверка связи с сервером Smartup (FR-ADM-01). Перечень в CHECK hdu_server_checks_c1. */
export const SERVER_ISSUES = [
  'unreachable',
  'timeout',
  'not_json',
  'issuer_mismatch',
  'no_authorization_endpoint',
  'no_token_endpoint',
  // Больше не выдаётся (проверка main, Q21), остаётся для прежних записей проверки в hdu_server_checks.
  'no_userinfo_endpoint',
  'no_jwks',
  'no_pkce_s256',
] as const;
export type ServerIssue = (typeof SERVER_ISSUES)[number];

/** Способы входа, которыми портал сам выдаёт сессию по своей одноразовой ссылке. */
export const TRUSTED_SIGN_IN_WAYS = ['invitation', 'telegram'] as const;
export type TrustedSignInWay = (typeof TRUSTED_SIGN_IN_WAYS)[number];

/** Служебная организация "Неопознанные" (раздел 10.1, решение 12 вехи M4): идентификатор закреплён миграцией 0035. */
export const SERVICE_ORG_ID = '00000000-0000-7000-8000-000000000001';
export const SERVICE_ORG_NAME = 'Неопознанные';

/**
 * Домены общих почтовых служб (FR-EM-06): по ним нельзя узнать организацию, такой домен организации не присваивается.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'mail.com',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru', 'yandex.ru', 'yandex.com', 'yandex.uz', 'ya.ru', 'rambler.ru',
  'umail.uz', 'inbox.uz', 'mail.uz', 'bk.uz',
]);
