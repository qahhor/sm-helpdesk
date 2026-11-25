import { cleanHints, type WidgetHints } from './protocol';

// Режим B виджета (план M6, задача 8; FR-WG-04, решения 11 и 12). Загрузчик открывает в новой вкладке
// /{язык}/tickets/new#widget=1&hints=<JSON подсказок>. Фрагмент браузер на сервер не отправляет, поэтому текст ошибки
// не попадает в журнал Caddy и портала.
//
// До формы клиент может пройти вход (Smartup OAuth уводит вкладку на другой сайт, фрагмент там теряется) и выбор
// организации. Поэтому страница входа, выбора организации и сама форма сразу переносят фрагмент в sessionStorage этой
// вкладки и убирают его из адреса (history.replaceState) до любого запроса. Форма забирает запись один раз.
// Подсказки не подписаны: они только предзаполняют форму и поля контекста, на права не влияют.

export type WidgetHandoff = { hints: WidgetHints };

const KEY = 'hub.widget-handoff';
/** Сколько ждёт запись режима B: на вход и выбор организации хватает, старая ошибка не подставится в чужую форму. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Фрагмент режима B: признак widget=1 и необязательные подсказки. Чужой фрагмент даёт null. */
export function parseWidgetFragment(hash: string): WidgetHandoff | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('widget') !== '1') return null;
  const raw = params.get('hints');
  if (!raw) return { hints: {} };
  try {
    return { hints: cleanHints(JSON.parse(raw)) };
  } catch {
    return { hints: {} };
  }
}

/** Переносит фрагмент режима B в хранилище вкладки. true, если фрагмент был фрагментом режима B и сохранён. */
export function stashWidgetHandoff(storage: Store | null, hash: string, now: Date): boolean {
  const handoff = parseWidgetFragment(hash);
  if (!handoff || !storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify({ at: now.getTime(), hints: handoff.hints }));
    return true;
  } catch {
    return false;
  }
}

/** Забирает запись режима B один раз. Старше HANDOFF_TTL_MS, испорченная или недоступная: null. */
export function takeWidgetHandoff(storage: Store | null, now: Date): WidgetHandoff | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return null;
    storage.removeItem(KEY);
    const saved = JSON.parse(raw) as { at?: unknown; hints?: unknown };
    if (typeof saved.at !== 'number' || now.getTime() - saved.at > HANDOFF_TTL_MS || now.getTime() < saved.at - 60_000) return null;
    return { hints: cleanHints(saved.hints) };
  } catch {
    return null;
  }
}

/** Описание из ошибки Smartup: "код: текст", как в панели виджета. */
export function handoffDescription(hints: WidgetHints): string {
  return [hints.errorCode, hints.errorText].filter(Boolean).join(': ');
}

function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Переносит фрагмент режима B из адреса текущей страницы в хранилище вкладки и убирает его из адреса. Вызывается в
 * первом эффекте страницы до любого запроса. Чужой фрагмент не трогает.
 */
export function captureWidgetFragment(now: Date = new Date()): void {
  if (!parseWidgetFragment(window.location.hash)) return;
  stashWidgetHandoff(sessionStore(), window.location.hash, now);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

/** Забирает подсказки режима B для формы: сначала из адреса самой формы, затем из хранилища вкладки. */
export function takeBrowserHandoff(now: Date = new Date()): WidgetHandoff | null {
  captureWidgetFragment(now);
  return takeWidgetHandoff(sessionStore(), now);
}
