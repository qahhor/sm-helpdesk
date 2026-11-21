import type { DraftStore } from './drafts';

// Недавние значения поля на устройстве (решение 14 плана M2): последние выбранные модули показываются сверху.
// Хранилище может быть недоступно: тогда списка недавних просто нет, поле работает.

const PREFIX = 'hub:recent:';
const LIMIT = 5;

export const recentKey = (userId: string, field: string): string => `${PREFIX}${userId}:${field}`;

export function loadRecent(store: DraftStore | null, key: string): string[] {
  try {
    const raw = store?.getItem(key);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

/** Ставит значение первым, без повторов, не больше пяти. Возвращает новый список. */
export function pushRecent(store: DraftStore | null, key: string, value: string): string[] {
  if (!value) return loadRecent(store, key);
  const next = [value, ...loadRecent(store, key).filter((item) => item !== value)].slice(0, LIMIT);
  try {
    store?.setItem(key, JSON.stringify(next));
  } catch {
    // Нет места или доступа: список недавних не сохранится.
  }
  return next;
}
