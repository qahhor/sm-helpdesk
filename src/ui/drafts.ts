import { useMemo, useSyncExternalStore } from 'react';

// Черновики обращения и ответа на устройстве (UX-C-02, FR-TK-16, решение 0026 пункт 8). Ключ включает пользователя
// и место: на общем устройстве чужой черновик не подставится. Хранилище может быть недоступно (приватный режим,
// нет места): тогда черновик просто не сохраняется, форма работает.

export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type Draft = Record<string, string>;

const PREFIX = 'hub:draft:';

export const draftKey = (userId: string, scope: string): string => `${PREFIX}${userId}:${scope}`;

/** Хранилище браузера или null (сервер, запрет доступа). */
export function browserDrafts(): DraftStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Сохраняет черновик. Пустой (одни пробелы) удаляется, а не хранится. */
export function saveDraft(store: DraftStore | null, key: string, value: Draft): void {
  try {
    if (Object.values(value).every((part) => part.trim() === '')) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(value));
  } catch {
    // Нет места или доступа: черновик не сохранится, текст в форме остаётся.
  }
}

export function loadDraft(store: DraftStore | null, key: string): Draft | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return null;
  }
}

export function clearDraft(store: DraftStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Нет доступа: удалить нечего.
  }
}

const noop = () => () => {};

/**
 * Черновик после гидратации: на сервере и при гидратации null, затем значение из хранилища. Форма пересоздаёт поля
 * по ключу `hydrated`, поэтому восстановление не меняет состояние в эффекте и не ломает гидратацию.
 */
export function useDraft(key: string): { hydrated: boolean; draft: Draft | null } {
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const draft = useMemo(() => (hydrated ? loadDraft(browserDrafts(), key) : null), [hydrated, key]);
  return { hydrated, draft };
}
