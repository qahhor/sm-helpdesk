// Поиск на Typesense (план W6; ТЗ 11.11 SearchReader и SearchIndexWriter; решения 0080-0082). Typesense только
// ускоряет текстовый поиск и ничего не решает о правах: из ответа берутся идентификаторы и порядок, строки читаются из
// PostgreSQL через withActor, политика RLS остаётся последним словом. Любой сбой даёт Fallback, и вызывающий идёт
// прежним путём PostgreSQL. Текст запроса и документов в журнал не попадает ни при какой ошибке.

/** Коллекции индекса. Имя в Typesense: псевдоним hub_<имя> на коллекцию hub_<имя>_v<N> (решение 12). */
export const SEARCH_COLLECTIONS = ['tickets', 'ticket_texts', 'solutions', 'ideas', 'orgs', 'people'] as const;
export type SearchCollection = (typeof SEARCH_COLLECTIONS)[number];

/** Имя псевдонима коллекции в Typesense. */
export const aliasOf = (collection: SearchCollection) => `hub_${collection}`;

/**
 * Для чего ищем. От цели зависят коллекции и вложенный в ключ фильтр (решение 2): клиенту обращения только своей
 * организации и решения только для клиентов, переписка и справочники только сотруднику (решение 0070, пункт 3).
 */
export type SearchPurpose = 'tickets' | 'solutions' | 'ideas' | 'directory';

/** Параметры, которые портал вкладывает в каждый ключ с областью: их нельзя переопределить запросом. */
export type EmbeddedParams = {
  filter_by?: string;
  include_fields: 'id';
  highlight_fields: 'none';
  use_cache: false;
  filter_curated_hits: true;
  expires_at: number;
};

declare const scopedKeyBrand: unique symbol;

/**
 * Ключ с областью. Строит только scopeFor (scoped-key.ts) из проверенного актора: функция вызова Typesense принимает
 * только этот тип, ключ без области передать ей нельзя.
 */
export type ScopedKey = {
  readonly value: string;
  readonly purpose: SearchPurpose;
  readonly collections: readonly SearchCollection[];
  /** Вложенные параметры: заглушка применяет их так же, как Typesense. */
  readonly embedded: EmbeddedParams;
  readonly [scopedKeyBrand]: true;
};

/** Один поиск в многократном запросе (multi_search, api/federated-multi-search). */
export type SearchSpec = {
  collection: SearchCollection;
  q: string;
  queryBy: readonly string[];
  queryByWeights?: readonly number[];
  /** Условие сверх вложенного в ключ: Typesense соединяет их через "и". */
  filterBy?: string;
  /** Начало слова для последнего слова запроса; по полю или для всех. */
  prefix?: boolean;
  /** Одна строка на значение поля (поле с facet). */
  groupBy?: string;
  perPage: number;
  numTypos?: number;
  splitJoinTokens?: 'off' | 'fallback' | 'always';
  dropTokensThreshold?: number;
  typoTokensThreshold?: number;
  /** Часть слова в середине (поля с infix): по полю queryBy. */
  infix?: readonly ('off' | 'always' | 'fallback')[];
  stopwords?: string;
};

/** Найденный документ: только идентификатор и признаки совпадения. Текста из Typesense портал не берёт. */
export type SearchHitId = {
  id: string;
  /** Очки совпадения Typesense (text_match): только для порядка внутри одного списка. */
  textMatch: number;
  /** Сколько слов запроса совпало (text_match_info.tokens_matched). */
  tokensMatched: number;
};

export type SearchResult = { hits: SearchHitId[]; found: number };

export type SearchIds = { kind: 'ids'; results: SearchResult[] };

export type SearchFailure = 'disabled' | 'no_key' | 'timeout' | 'unreachable' | 'invalid_response' | 'breaker_open' | `http_${number}`;

/** Typesense недоступен или выключен: вызывающий ищет прежним путём PostgreSQL (решение 14). */
export type SearchFallback = { kind: 'fallback'; reason: SearchFailure };

export interface SearchReader {
  readonly name: 'typesense' | 'postgres' | 'stub';
  /** Поиски одним вызовом. Все поиски должны идти в коллекции области ключа. */
  searchIds(scope: ScopedKey, searches: readonly SearchSpec[], opts: { timeoutMs: number }): Promise<SearchIds | SearchFallback>;
}

/** Значение поля документа индекса. */
export type SearchValue = string | number | boolean | readonly string[];

/** Документ индекса: идентификатор, версия (время изменения строки в микросекундах) и поля коллекции. */
export type SearchDocument = { id: string; version: number } & { [field: string]: SearchValue | undefined };

/** Синонимы (api/synonyms): многосторонние без root, односторонние с root. */
export type SynonymItem = { id: string; synonyms: string[]; root?: string; locale?: string };
/** Правило курирования (api/curation): по запросу поставить документы на места. */
export type CurationItem = { id: string; query: string; match: 'exact' | 'contains'; includes: { id: string; position: number }[] };
/** Пара словаря стемминга (api/stemming): слово и его корень. */
export type StemPair = { word: string; root: string };

export type CollectionInfo = { name: string; numDocuments: number; createdAt: number };

export interface SearchIndexWriter {
  readonly name: 'typesense' | 'stub';
  /** Создаёт недостающие коллекции v1, псевдонимы, набор синонимов и словарь. Повтор безвреден. */
  ensureCollections(): Promise<void>;
  /** Пачка upsert в коллекцию (через псевдоним или по имени версии). Документ со старшей версией не перезаписывается. */
  upsert(target: SearchCollection | { name: string }, docs: readonly SearchDocument[]): Promise<void>;
  remove(collection: SearchCollection, ids: readonly string[]): Promise<void>;
  /** Удаляет документы по условию (все языки решения или идеи, кроме оставшихся). */
  removeWhere(collection: SearchCollection, filterBy: string): Promise<void>;
  /** Идентификаторы, версии и отпечатки содержимого всех документов коллекции: для сверки. */
  exportDocs(collection: SearchCollection): Promise<Map<string, { version: number; hash: string | null }>>;
  putSynonyms(items: readonly SynonymItem[]): Promise<void>;
  putCurations(items: readonly CurationItem[]): Promise<void>;
  putStems(pairs: readonly StemPair[]): Promise<void>;
  /** Пары словаря, которые сейчас в Typesense: смена словаря перестраивает коллекции, без смены не нужна. */
  readStems(): Promise<StemPair[]>;
  /**
   * Отметка словаря, с которым построена действующая версия коллекции (stemsMarkOf). Версия создана до появления
   * отметок или коллекции нет: null.
   */
  stemsMark(collection: SearchCollection): Promise<string | null>;
  /** Переиндексация (решение 12): коллекции, псевдонимы, новая версия. */
  listCollections(): Promise<CollectionInfo[]>;
  aliasTarget(collection: SearchCollection): Promise<string | null>;
  /** Новая версия коллекции. Запоминает в ней отметку словаря, который сейчас в Typesense: с ним она и строится. */
  createVersion(collection: SearchCollection, version: number): Promise<string>;
  switchAlias(collection: SearchCollection, name: string): Promise<void>;
  dropCollection(name: string): Promise<void>;
  /** Здоровье и память для hub search:status и ops.watch (api/cluster-operations). */
  health(): Promise<boolean>;
  memory(): Promise<{ usedBytes: number; totalBytes: number } | null>;
}

/** Ошибка записи в индекс: только код, без текста документа. */
export class SearchWriteError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`индекс поиска: ${code}`);
    this.name = 'SearchWriteError';
    this.code = code;
  }
}
