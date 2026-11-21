// Модуль hdu, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).
import { randomUUID } from 'node:crypto';
import { CLIENT_ROLES, type ClientRole, SERVER_CODE_PATTERN } from './pref';

const SSO_CALLBACK = /^\/api\/auth\/sso\/callback\/([^/]+)$/;

/**
 * Какие запросы к библиотеке входа открыты снаружи. Только возврат с сервера Smartup:
 * /api/auth/sso/callback/<код сервера>. Остальные адреса библиотеки (их 54) портал снаружи не отдаёт:
 * вход, сессии и ссылки вызываются серверными действиями как функции (решение 0012).
 */
export function isAllowedAuthRequest(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  const code = SSO_CALLBACK.exec(pathname)?.[1];
  return code !== undefined && SERVER_CODE_PATTERN.test(code);
}

const MAX_RETURN_PATH = 2000;
const PLACEHOLDER_ORIGIN = 'http://hub.invalid';

/** Управляющие знаки (перевод строки, табуляция, нулевой байт и другие) и обратная косая черта. */
function hasUnsafeChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '\\') return true;
  }
  return false;
}

/**
 * Адрес возврата после входа: только путь внутри портала (ТЗ 14.3). Всё остальное заменяется запасным адресом.
 *
 * Отклоняются адреса с узлом и схемой, пути с двумя косыми чертами в начале, обратная косая черта
 * (браузеры читают её как обычную), управляющие знаки и те же приёмы в закодированном виде.
 */
export function safeReturnPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH) return fallback;
  if (raw[0] !== '/' || raw[1] === '/' || hasUnsafeChars(raw)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (decoded[1] === '/' || hasUnsafeChars(decoded)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN || url.pathname.startsWith('//')) return fallback;
  return `${url.pathname}${url.search}`;
}

const SYNTHETIC_DOMAIN = '@users.invalid';

/**
 * Служебный адрес учётной записи, у которой ещё нет подтверждённого email (решение 0013).
 * Библиотека входа требует уникальный адрес, а Smartup чаще его не передаёт. Домен .invalid
 * зарезервирован и никогда не принимает почту: на служебный адрес письмо уйти не может.
 */
export function syntheticEmail(): string {
  return `u-${randomUUID()}${SYNTHETIC_DOMAIN}`;
}

export function isSyntheticEmail(email: string): boolean {
  return /^u-[0-9a-f-]{36}@users\.invalid$/.test(email);
}

export type DeviceInfo = {
  browser: 'chrome' | 'firefox' | 'safari' | 'edge' | 'other';
  os: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'other';
};

/** Строку браузера длиннее этого не разбираем: настоящие строки короче, длинная это мусор или атака. */
const USER_AGENT_LIMIT = 512;

/**
 * Браузер и система по строке браузера для списка сессий. Строка присылается браузером и может быть любой:
 * в интерфейс уходят только значения из закрытого списка, сама строка не показывается.
 */
export function describeUserAgent(ua: string | null): DeviceInfo {
  if (!ua || ua.length > USER_AGENT_LIMIT) return { browser: 'other', os: 'other' };
  const os: DeviceInfo['os'] = /iPhone|iPad|iPod/.test(ua)
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : /Windows NT/.test(ua)
        ? 'windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macos'
          : /Linux|X11/.test(ua)
            ? 'linux'
            : 'other';
  const browser: DeviceInfo['browser'] = /Edg(e|A|iOS)?\//.test(ua)
    ? 'edge'
    : /Firefox\/|FxiOS\//.test(ua)
      ? 'firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'chrome'
        : /Version\/[\d.]+.*Safari\//.test(ua)
          ? 'safari'
          : 'other';
  return { browser, os };
}

/**
 * Показать ли строку о политике обработки данных: политика включена (есть действующая версия),
 * а пользователь видел другую версию или не видел никакой.
 */
export function needsPolicyNotice(user: { policyVersion: string | null }, current: string | null): boolean {
  return current !== null && user.policyVersion !== current;
}

/**
 * Роль клиента по соответствию ролей сервера Smartup. Ищется только среди собственных ключей
 * соответствия: роль `constructor` или `__proto__` не находит свойство объекта (итоговая проверка M1).
 */
export function mapClientRole(roleMap: Record<string, ClientRole>, role: string | undefined): ClientRole {
  if (!role || !Object.hasOwn(roleMap, role)) return 'client_user';
  const mapped: unknown = roleMap[role];
  return (CLIENT_ROLES as readonly unknown[]).includes(mapped) ? (mapped as ClientRole) : 'client_user';
}
