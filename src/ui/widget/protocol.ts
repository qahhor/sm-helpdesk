// Протокол postMessage версии 1 со стороны страницы виджета (план M6, решение 8; ТЗ 11.9). Пара к загрузчику
// src/widget/loader.js. Каждое сообщение { hub: 1, type, ... }, схема с обеих сторон, неизвестный тип отбрасывается.
//
// Хозяин странице: init (токен контекста, подсказки, тема, язык), token (новый токен контекста), hints.
// Страница хозяину: ready, need-token, close, ticket-created (только номер).
//
// Страница принимает сообщение, только если event.source это window.parent и event.origin равен адресу хозяина,
// проверенному по адресам встраивания сервера. Отправляет только на этот точный адрес, адрес "*" не используется.
// Адрес хозяина: location.ancestorOrigins, где он есть, иначе параметр загрузчика ?origin=, сверенный с тем же списком.
//
// Схема записана проверками без библиотеки: Zod (и zod/mini) занял бы 17 КБ из бюджета скриптов страницы виджета
// 170 КБ на телефоне (ТЗ 8.9, решение 0059). Правила те же: точный набор полей, типы, пределы длины.
//
// Подсказки (решение 11) не подписаны и влияют только на предзаполнение, поиск и поля контекста обращения: неверная
// подсказка отбрасывается, форма работает без неё. Текст подсказки нигде не выводится как HTML или ссылка.

export const PROTOCOL_VERSION = 1;

/** Подсказки хозяина после проверки. Каждое поле есть, только если прошло проверку. */
export type WidgetHints = { module?: string; form?: string; appVersion?: string; errorCode?: string; errorText?: string };
export type WidgetTheme = 'light' | 'dark';

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
// Управляющие знаки, кроме перевода строки и табуляции, в подсказках не нужны.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

type Rule = (value: string) => boolean;
const text = (max: number): Rule => (value) => value.length >= 1 && value.length <= max;
const HINT_RULES: Record<keyof WidgetHints, Rule> = {
  module: (value) => CODE.test(value),
  form: (value) => CODE.test(value),
  appVersion: text(32),
  errorCode: text(64),
  errorText: text(2000),
};

/** Подсказки по решению 11: каждое поле проверяется отдельно, неверное отбрасывается. */
export function cleanHints(raw: unknown): WidgetHints {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const hints: WidgetHints = {};
  for (const key of Object.keys(HINT_RULES) as (keyof WidgetHints)[]) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const cleaned = value.replace(CONTROL, '').trim();
    if (HINT_RULES[key](cleaned)) hints[key] = cleaned;
  }
  return hints;
}

const TOKEN = /^[A-Za-z0-9_.-]{1,8192}$/;
const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
/** Поля каждого типа сообщения хозяина: другие поля и другие типы не принимаются. */
const HOST_FIELDS: Record<string, readonly string[]> = {
  init: ['hub', 'type', 'token', 'hints', 'theme', 'locale'],
  token: ['hub', 'type', 'token'],
  hints: ['hub', 'type', 'hints'],
};

export type HostMessage =
  | { type: 'init'; token: string; hints: WidgetHints; theme: WidgetTheme | null }
  | { type: 'token'; token: string }
  | { type: 'hints'; hints: WidgetHints };

/** Сообщение хозяина после проверки схемы. Неизвестный тип, другая версия, лишнее поле или неверное значение: null. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  const fields = typeof message.type === 'string' && Object.hasOwn(HOST_FIELDS, message.type) ? HOST_FIELDS[message.type] : undefined;
  if (message.hub !== PROTOCOL_VERSION || !fields || Object.keys(message).some((key) => !fields.includes(key))) return null;
  if (message.type === 'init') {
    if (!isToken(message.token)) return null;
    return { type: 'init', token: message.token, hints: cleanHints(message.hints), theme: message.theme === 'dark' || message.theme === 'light' ? message.theme : null };
  }
  if (message.type === 'token') return isToken(message.token) ? { type: 'token', token: message.token } : null;
  return { type: 'hints', hints: cleanHints(message.hints) };
}

export type FrameMessage = { type: 'ready' } | { type: 'need-token' } | { type: 'close' } | { type: 'ticket-created'; number: number };

/** Начало адреса (схема, узел, порт) или null. */
function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * Адрес хозяина, которому страница отвечает. Пусто: адреса нет в списке сервера или он не совпал с параметром
 * загрузчика, и страница не отправляет хозяину ничего. Не во фрейме (window.parent это само окно): тоже пусто.
 */
export function resolveHostOrigin(input: { allowed: readonly string[]; ancestorOrigins: ArrayLike<string> | null | undefined; param: string | null; framed: boolean }): string | null {
  if (!input.framed) return null;
  const allowed = new Set(input.allowed.map((value) => originOf(value)).filter((value): value is string => value !== null));
  const param = originOf(input.param);
  const ancestor = input.ancestorOrigins && input.ancestorOrigins.length > 0 ? originOf(input.ancestorOrigins[0]) : undefined;
  // Браузер назвал родителя сам: параметр загрузчика не может его подменить.
  const candidate = ancestor !== undefined ? ancestor : param;
  if (!candidate || !allowed.has(candidate)) return null;
  if (ancestor !== undefined && param !== null && param !== ancestor) return null;
  return candidate;
}

type MessageEventLike = { origin: string; source: unknown; data: unknown };

/** Сообщение хозяина, если оно пришло из окна-родителя с проверенного адреса и прошло схему. Иначе null. */
export function acceptHostMessage(event: MessageEventLike, expected: { parent: unknown; hostOrigin: string | null }): HostMessage | null {
  if (!expected.hostOrigin || event.source !== expected.parent || event.origin !== expected.hostOrigin) return null;
  return parseHostMessage(event.data);
}

type PostTarget = { postMessage(message: unknown, targetOrigin: string): void };

/** Сообщение хозяину только на точный проверенный адрес. Без адреса не отправляется ничего. */
export function sendToHost(parent: PostTarget, hostOrigin: string | null, message: FrameMessage): boolean {
  if (!hostOrigin || hostOrigin === '*') return false;
  parent.postMessage({ hub: PROTOCOL_VERSION, ...message }, hostOrigin);
  return true;
}
