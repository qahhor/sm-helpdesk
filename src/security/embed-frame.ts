// Кто может встраивать страницы виджета (ТЗ 14.4, FR-WG-09, угроза T9; план M6, задача 3, решение 6).
//
// Страница виджета /{язык}/embed/... несёт в адресе ключ встраивания сервера Smartup (?key=...). Прокси ставит в
// frame-ancestors только адреса этого сервера: начало адреса Smartup Web и его дополнительные адреса из реестра.
// Неизвестный или отключённый ключ, страница без ключа и любая другая страница портала: frame-ancestors 'none'.
// Список всех серверов в заголовок не попадает: он раскрыл бы, кто клиент выделенного сервера (FR-ID-03).
//
// Файл без 'server-only' и без обращения к базе: его загружает прокси. Список держится в памяти процесса и
// обновляется из базы не реже раза в 60 секунд (загрузчик регистрирует src/wiring.ts) и сразу после правки реестра
// в этом процессе. Это настройки реестра, а не данные клиентов (решение 6 плана): кешировать их можно.

export const EMBED_REFRESH_MS = 60_000;
/** После неудачной загрузки следующая попытка не раньше чем через 5 секунд: база могла лечь. */
const RETRY_MS = 5_000;
/** Параметр адреса страницы виджета с ключом встраивания. */
export const EMBED_KEY_PARAM = 'key';
const EMBED_KEY = /^[0-9a-f]{32}$/;

/** Адреса встраивания по ключу встраивания действующих серверов. */
export type EmbedOriginsLoader = () => Promise<Map<string, string[]>>;

type State = { loader: EmbedOriginsLoader | null; byKey: Map<string, string[]>; loadedAt: number; inflight: Promise<void> | null };

const shared = globalThis as typeof globalThis & { __hubEmbedFrame?: State };
const state = (): State => (shared.__hubEmbedFrame ??= { loader: null, byKey: new Map(), loadedAt: Number.NEGATIVE_INFINITY, inflight: null });

/** Загрузчик из базы. Без него (команда консоли, тесты без базы) встраивать нельзя ни с какого адреса. */
export function registerEmbedOriginsLoader(loader: EmbedOriginsLoader | null): void {
  const s = state();
  s.loader = loader;
  s.byKey = new Map();
  s.loadedAt = Number.NEGATIVE_INFINITY;
}

/** Загружает список заново. Одновременные вызовы ждут одну загрузку. Ошибка оставляет прежний список. */
export function refreshEmbedOrigins(): Promise<void> {
  const s = state();
  if (!s.loader) return Promise.resolve();
  const loader = s.loader;
  s.inflight ??= loader()
    .then(
      (byKey) => {
        s.byKey = byKey;
        s.loadedAt = Date.now();
      },
      () => {
        s.loadedAt = Date.now() - EMBED_REFRESH_MS + RETRY_MS;
      },
    )
    .finally(() => {
      s.inflight = null;
    });
  return s.inflight;
}

/**
 * Адреса, которым можно встраивать страницу виджета с этим ключом. Пустой список: встраивать нельзя никому.
 * Список старше 60 секунд сначала загружается заново.
 */
export async function embedAncestors(key: string | null): Promise<string[]> {
  if (!key || !EMBED_KEY.test(key)) return [];
  if (Date.now() - state().loadedAt >= EMBED_REFRESH_MS) await refreshEmbedOrigins();
  return [...(state().byKey.get(key) ?? [])];
}

const EMBED_PATH = /^\/[a-z]{2}\/embed(?:\/|$)/;
const MOBILE_PATH = /^\/[a-z]{2}\/m(?:\/|$)/;

/** Страница виджета для встраивания: /{язык}/embed и всё под ним. */
export function isEmbedPath(pathname: string): boolean {
  return EMBED_PATH.test(pathname);
}

/**
 * Страница виджета или страница для мобильного приложения: сессию портала они не используют, прокси её куку не
 * трогает и в запрос не передаёт (раздел "На что смотреть", пункт 6).
 */
export function isWidgetPath(pathname: string): boolean {
  return EMBED_PATH.test(pathname) || MOBILE_PATH.test(pathname);
}
