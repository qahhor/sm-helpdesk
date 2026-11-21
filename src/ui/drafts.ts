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

// Отметка отправки (FR-TK-16, решение 0026 пункт 8): форма перед отправкой кладёт в хранилище вкладки
// (sessionStorage) копию отправляемого черновика. Страница успеха удаляет черновик, только если он всё ещё равен
// этой копии, и сразу снимает отметку. Повторно открытая ссылка на страницу успеха, переход по истории, другая
// вкладка или другой браузер новый черновик не стирают.

const SENT_PREFIX = 'hub:sent:';
const sentKey = (key: string) => SENT_PREFIX + (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key);
const fingerprint = (value: Draft) => JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Хранилище вкладки или null. */
export function browserSession(): DraftStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Запоминает, какой черновик уходит. Вызывается при отправке формы. */
export function rememberSent(session: DraftStore | null, key: string, value: Draft): void {
  try {
    session?.setItem(sentKey(key), fingerprint(value));
  } catch {
    // Нет места или доступа: черновик после отправки останется, текст не теряется.
  }
}

/** Отправка не удалась: отметка снимается, черновик остаётся черновиком. */
export function forgetSent(session: DraftStore | null, key: string): void {
  clearDraft(session, sentKey(key));
}

/** Черновик на устройстве совпадает с отправленным. Только чтение: можно вызывать при отрисовке. */
export function sentMatches(local: DraftStore | null, session: DraftStore | null, key: string): boolean {
  try {
    const sent = session?.getItem(sentKey(key));
    const draft = loadDraft(local, key);
    return Boolean(sent) && draft !== null && fingerprint(draft) === sent;
  } catch {
    return false;
  }
}

/** Удаляет черновик, если ушёл именно он, и снимает отметку отправки в любом случае. */
export function clearIfSent(local: DraftStore | null, session: DraftStore | null, key: string): boolean {
  const matches = sentMatches(local, session, key);
  if (matches) clearDraft(local, key);
  forgetSent(session, key);
  return matches;
}

const noop = () => () => {};

/**
 * Черновик после гидратации: на сервере и при гидратации null, затем значение из хранилища. Форма пересоздаёт поля
 * по ключу `hydrated`, поэтому восстановление не меняет состояние в эффекте и не ломает гидратацию.
 * sent: страница открылась с отметкой успеха. Поле пустое, только если на устройстве лежит именно отправленный
 * текст (его удаляет DraftCleaner); любой другой черновик подставляется как обычно (FR-TK-16). Хранилище здесь
 * только читается.
 */
export function useDraft(key: string, sent = false): { hydrated: boolean; draft: Draft | null } {
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const draft = useMemo(() => {
    if (!hydrated) return null;
    if (sent && sentMatches(browserDrafts(), browserSession(), key)) return null;
    return loadDraft(browserDrafts(), key);
  }, [hydrated, key, sent]);
  return { hydrated, draft };
}
