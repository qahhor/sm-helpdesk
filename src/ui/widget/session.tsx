'use client';

import { createContext, useContext } from 'react';
import type { WidgetHints } from './protocol';

// Общее состояние страницы виджета (план M6, задачи 5-7): токен виджета в памяти, подсказки хозяина, тексты, переходы.
// Два поставщика: EmbedSession (iframe в Smartup Web, токен контекста через postMessage) и MobileSession (страница
// /m/report, токен контекста во фрагменте адреса). Экраны "Сообщить" и "Мои обращения" одни и те же.
//
// Токен виджета живёт только здесь, в памяти страницы: ни localStorage, ни sessionStorage, ни куки (решение 1).
// Каждый запрос к API виджета несёт его в заголовке Authorization; сессия портала страницами виджета не читается.

export type WidgetStatus = 'waiting' | 'ready' | 'refused' | 'denied' | 'expired' | 'unavailable' | 'offline';

/** Тексты страниц виджета: готовые строки с сервера, подстановки вида {name} заменяет fill. */
export type WidgetLabels = Record<string, string>;

/** Куда перейти внутри виджета. Во фрейме это адреса /embed/*, на странице приложения смена экрана без перехода. */
export type WidgetNav = { report(): void; tickets(): void; ticket(number: number): void; portalHref(path: string): string };

export type WidgetSession = {
  status: WidgetStatus;
  platform: 'web' | 'android' | 'ios' | null;
  locale: string;
  /** Пользователь и организация из токена виджета: только для ключа черновика на устройстве, не для прав. */
  draftScope: string | null;
  hints: WidgetHints;
  labels: WidgetLabels;
  /** Запрос к API портала с токеном виджета. 401: поставщик просит новый токен контекста. */
  request(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** Заголовок Authorization для загрузки файлов. */
  authHeaders(): Record<string, string>;
  ticketCreated(number: number): void;
  close: (() => void) | null;
  nav: WidgetNav;
};

export const WidgetContext = createContext<WidgetSession | null>(null);

export function useWidget(): WidgetSession {
  const session = useContext(WidgetContext);
  if (!session) throw new Error('useWidget: нет поставщика сессии виджета');
  return session;
}

/** Строка с подстановками {name}. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** Пользователь и организация из полезной части токена виджета (без проверки подписи: только для ключа черновика). */
export function draftScopeOf(token: string): string | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown; org?: unknown; plt?: unknown };
    return typeof json.sub === 'string' && typeof json.org === 'string' ? `${json.sub}:${json.org}` : null;
  } catch {
    return null;
  }
}

/** Платформа из полезной части токена виджета (подсказка для экрана; права проверяет сервер). */
export function platformOf(token: string): WidgetSession['platform'] {
  try {
    const part = token.split('.')[1] ?? '';
    const plt = (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { plt?: unknown }).plt;
    return plt === 'web' || plt === 'android' || plt === 'ios' ? plt : null;
  } catch {
    return null;
  }
}

export type Exchange = { token: string; expiresIn: number } | { failed: Exclude<WidgetStatus, 'waiting' | 'ready' | 'refused'> };

/** Обмен токена контекста на токен виджета (POST /api/embed/session). Текущий токен виджета отличает продление. */
export async function exchangeContextToken(contextToken: string, current: string | null): Promise<Exchange> {
  let response: Response;
  try {
    response = await fetch('/api/embed/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(current ? { Authorization: `Bearer ${current}` } : {}) },
      body: JSON.stringify({ contextToken }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { failed: 'offline' };
  }
  if (response.status === 401) return { failed: 'expired' };
  if (response.status === 403) return { failed: 'denied' };
  if (!response.ok) return { failed: 'unavailable' };
  const body = (await response.json().catch(() => null)) as { embedToken?: unknown; expiresIn?: unknown } | null;
  if (typeof body?.embedToken !== 'string' || typeof body.expiresIn !== 'number') return { failed: 'unavailable' };
  return { token: body.embedToken, expiresIn: body.expiresIn };
}

/** Запрос к API виджета с токеном. Без кук: credentials omit. */
export function widgetFetch(token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'omit',
    cache: 'no-store',
  });
}
