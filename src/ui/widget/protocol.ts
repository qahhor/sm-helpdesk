import * as z from 'zod/mini';

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
// Подсказки (решение 11) не подписаны и влияют только на предзаполнение, поиск и поля контекста обращения: неверная
// подсказка отбрасывается, форма работает без неё. Текст подсказки нигде не выводится как HTML или ссылка.

export const PROTOCOL_VERSION = 1;

/** Подсказки хозяина после проверки. Каждое поле есть, только если прошло проверку. */
export type WidgetHints = { module?: string; form?: string; appVersion?: string; errorCode?: string; errorText?: string };
export type WidgetTheme = 'light' | 'dark';

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
// Управляющие знаки, кроме перевода строки и табуляции, в подсказках не нужны.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const HINT_RULES = {
  module: z.string().check(z.regex(CODE)),
  form: z.string().check(z.regex(CODE)),
  appVersion: text(32),
  errorCode: text(64),
  errorText: text(2000),
} as const;

/** Подсказки по решению 11: каждое поле проверяется отдельно, неверное отбрасывается. */
export function cleanHints(raw: unknown): WidgetHints {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const hints: WidgetHints = {};
  for (const key of Object.keys(HINT_RULES) as (keyof WidgetHints)[]) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const cleaned = value.replace(CONTROL, '').trim();
    const parsed = z.safeParse(HINT_RULES[key], cleaned);
    if (parsed.success) hints[key] = parsed.data;
  }
  return hints;
}

const contextToken = z.string().check(z.minLength(1), z.maxLength(8192), z.regex(/^[A-Za-z0-9_.-]+$/));

const hostMessage = z.discriminatedUnion('type', [
  z.object({ hub: z.literal(PROTOCOL_VERSION), type: z.literal('init'), token: contextToken, hints: z.optional(z.unknown()), theme: z.optional(z.unknown()), locale: z.optional(z.unknown()) }),
  z.object({ hub: z.literal(PROTOCOL_VERSION), type: z.literal('token'), token: contextToken }),
  z.object({ hub: z.literal(PROTOCOL_VERSION), type: z.literal('hints'), hints: z.unknown() }),
]);

export type HostMessage =
  | { type: 'init'; token: string; hints: WidgetHints; theme: WidgetTheme | null }
  | { type: 'token'; token: string }
  | { type: 'hints'; hints: WidgetHints };

/** Сообщение хозяина после проверки схемы. Неизвестный тип, другая версия, лишнее или неверное: null. */
export function parseHostMessage(data: unknown): HostMessage | null {
  const parsed = z.safeParse(hostMessage, data);
  if (!parsed.success) return null;
  const message = parsed.data;
  if (message.type === 'init')
    return { type: 'init', token: message.token, hints: cleanHints(message.hints), theme: message.theme === 'dark' || message.theme === 'light' ? message.theme : null };
  if (message.type === 'token') return { type: 'token', token: message.token };
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
