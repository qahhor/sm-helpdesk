import { foldText } from './fold';
import { isScopedKey } from './scoped-key';
import {
  type CurationItem,
  type ScopedKey,
  type SearchCollection,
  type SearchDocument,
  type SearchFallback,
  type SearchIds,
  type SearchIndexWriter,
  type SearchReader,
  type SearchSpec,
  type StemPair,
  type SynonymItem,
} from './types';

// Заглушка Typesense в памяти процесса (план W6, задача 1): тесты и машина разработчика. Ищет по свёрнутым словам
// (fold.ts) с опечатками до 1 правки для слов от 4 знаков и до 2 от 7, последнее слово запроса как начало слова,
// применяет вложенный в ключ фильтр и условие запроса. Переключатель "сломать фильтр" отключает вложенный фильтр:
// так тесты проверяют второй слой изоляции (строки читаются под RLS). Курирование: закреплённые документы ставятся
// первыми, вложенный фильтр к ним применяется, как с filter_curated_hits: true.

type Store = Map<SearchCollection, Map<string, SearchDocument>>;

/** Расстояние Левенштейна с перестановкой соседних букв (Дамерау), не больше limit + 1. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

function tokenMatches(query: string, word: string, prefix: boolean, numTypos: number): boolean {
  if (query === word || (prefix && word.startsWith(query))) return true;
  if (/^\d+$/.test(query)) return false;
  const allowed = Math.min(numTypos, query.length >= 7 ? 2 : query.length >= 4 ? 1 : 0);
  if (allowed === 0) return false;
  if (prefix && word.length > query.length && distance(query, word.slice(0, query.length), allowed) <= allowed) return true;
  return distance(query, word, allowed) <= allowed;
}

/** Условие filter_by в простых видах: поле:=значение, поле:=[a,b], поле:!=[a,b], через && и || со скобками. */
function matchesFilter(doc: SearchDocument, filter: string | undefined): boolean {
  if (!filter) return true;
  const split = (text: string, op: string) => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      else if (depth === 0 && text.startsWith(op, i)) {
        parts.push(text.slice(start, i));
        start = i + op.length;
      }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim());
  };
  const evalExpr = (expr: string): boolean => {
    const ors = split(expr, '||');
    if (ors.length > 1) return ors.some(evalExpr);
    const ands = split(expr, '&&');
    if (ands.length > 1) return ands.every(evalExpr);
    const e = expr.trim();
    if (e.startsWith('(') && e.endsWith(')')) return evalExpr(e.slice(1, -1));
    const m = /^([a-z_]+):(!=|=)?\s*(\[[^\]]*\]|[^\s]+)$/.exec(e);
    if (!m) throw new Error('Заглушка поиска: условие не разобрано');
    const [, field, op, raw] = m as unknown as [string, string, string | undefined, string];
    const values = raw.startsWith('[') ? raw.slice(1, -1).split(',').map((v) => v.trim()) : [raw];
    const actual = doc[field];
    const have = Array.isArray(actual) ? actual.map(String) : actual === undefined ? [] : [String(actual)];
    const hit = have.some((v) => values.includes(v));
    return op === '!=' ? !hit : hit;
  };
  return evalExpr(filter);
}

export type StubSearch = SearchReader &
  SearchIndexWriter & {
    /** Отключить вложенный в ключ фильтр: проверка второго слоя изоляции. */
    breakFilter(broken: boolean): void;
    /** Сломать ответы: каждый поиск даёт Fallback с этой причиной. null чинит. */
    failWith(reason: SearchFallback['reason'] | null): void;
    documents(collection: SearchCollection): SearchDocument[];
    synonyms: readonly SynonymItem[];
    curations: readonly CurationItem[];
    stems: readonly StemPair[];
    /** Сколько раз набор уходил в Typesense: проверка, что настройки применены. */
    configWrites: { synonyms: number; stems: number; curations: number };
    clear(): void;
    /** Сколько поисков пришло: проверка, что путь Typesense вообще вызывался. */
    calls: number;
  };

export function createStubSearch(): StubSearch {
  const store: Store = new Map();
  let broken = false;
  let failure: SearchFallback['reason'] | null = null;
  const state = { synonyms: [] as SynonymItem[], curations: [] as CurationItem[], stems: [] as StemPair[], calls: 0, writes: { synonyms: 0, stems: 0, curations: 0 } };
  const coll = (c: SearchCollection) => {
    let m = store.get(c);
    if (!m) store.set(c, (m = new Map()));
    return m;
  };

  function run(scope: ScopedKey, spec: SearchSpec) {
    const queryWords = foldText(spec.q).split(' ').filter(Boolean);
    const scored: { doc: SearchDocument; matched: number }[] = [];
    for (const doc of coll(spec.collection).values()) {
      if (!broken && !matchesFilter(doc, scope.embedded.filter_by)) continue;
      if (!matchesFilter(doc, spec.filterBy)) continue;
      const words = new Set(
        spec.queryBy
          .flatMap((field) => {
            const value = doc[field];
            return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
          })
          .flatMap((text) => foldText(text).split(' ')),
      );
      let matched = 0;
      queryWords.forEach((q, i) => {
        const last = i === queryWords.length - 1;
        if ([...words].some((w) => tokenMatches(q, w, last && spec.prefix === true, spec.numTypos ?? 2))) matched++;
      });
      if (matched > 0 || spec.q === '*') scored.push({ doc, matched });
    }
    // Как drop_tokens_threshold 1 по умолчанию: слова отбрасываются, только если со всеми словами ничего нет. Остаются
    // документы с наибольшим числом совпавших слов.
    const best = Math.max(0, ...scored.map((x) => x.matched));
    scored.splice(0, scored.length, ...scored.filter((x) => x.matched === best || spec.q === '*'));
    scored.sort((a, b) => b.matched - a.matched || a.doc.id.localeCompare(b.doc.id));
    // Курирование: закреплённые документы первыми, если правило совпало с запросом.
    const pinned = state.curations
      .filter((c) => spec.collection === 'solutions' && (c.match === 'exact' ? foldText(c.query) === foldText(spec.q) : foldText(spec.q).includes(foldText(c.query))))
      .flatMap((c) => [...c.includes].sort((a, b) => a.position - b.position).map((inc) => inc.id));
    const pinnedDocs = pinned.map((id) => coll(spec.collection).get(id)).filter((d): d is SearchDocument => !!d && (broken || matchesFilter(d, scope.embedded.filter_by)));
    const ordered = [...pinnedDocs.map((doc) => ({ doc, matched: queryWords.length })), ...scored.filter((s) => !pinned.includes(s.doc.id))];
    const seen = new Set<string>();
    const grouped = spec.groupBy
      ? ordered.filter((s) => {
          const key = String(s.doc[spec.groupBy!]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      : ordered;
    return {
      hits: grouped.slice(0, spec.perPage).map((s) => ({ id: s.doc.id, textMatch: s.matched * 1000, tokensMatched: s.matched })),
      found: grouped.length,
    };
  }

  const self: StubSearch = {
    name: 'stub',
    get calls() {
      return state.calls;
    },
    async searchIds(scope, searches): Promise<SearchIds | SearchFallback> {
      if (!isScopedKey(scope)) throw new Error('Поиск: ключ без области не принимается');
      for (const spec of searches) if (!scope.collections.includes(spec.collection)) throw new Error('Поиск: коллекция вне области ключа');
      state.calls++;
      if (failure) return { kind: 'fallback', reason: failure };
      return { kind: 'ids', results: searches.map((spec) => run(scope, spec)) };
    },
    async ensureCollections() {},
    async upsert(target, docs) {
      const name = typeof target === 'string' ? target : (/^hub_([a-z_]+)_v\d+$/.exec(target.name)?.[1] as SearchCollection | undefined);
      if (!name) throw new Error('Заглушка поиска: неизвестная коллекция');
      const m = coll(name);
      for (const doc of docs) if ((m.get(doc.id)?.version ?? -1) <= doc.version) m.set(doc.id, { ...doc });
    },
    async remove(collection, ids) {
      for (const id of ids) coll(collection).delete(id);
    },
    async removeWhere(collection, filterBy) {
      for (const [id, doc] of coll(collection)) if (matchesFilter(doc, filterBy)) coll(collection).delete(id);
    },
    async exportDocs(collection) {
      return new Map([...coll(collection).values()].map((d) => [d.id, { version: d.version, hash: typeof d.content_hash === 'string' ? d.content_hash : null }]));
    },
    async putSynonyms(items) {
      state.synonyms = [...items];
      state.writes.synonyms++;
    },
    async putCurations(items) {
      state.curations = [...items];
      state.writes.curations++;
    },
    async putStems(pairs) {
      state.stems = [...pairs];
      state.writes.stems++;
    },
    async readStems() {
      return [...state.stems];
    },
    async listCollections() {
      return [...store.entries()].map(([name, docs]) => ({ name: `hub_${name}_v1`, numDocuments: docs.size, createdAt: 0 }));
    },
    async aliasTarget(collection) {
      return `hub_${collection}_v1`;
    },
    async createVersion(collection) {
      return `hub_${collection}_v1`;
    },
    async switchAlias() {},
    async dropCollection() {},
    async health() {
      return failure === null;
    },
    async memory() {
      return null;
    },
    breakFilter(value) {
      broken = value;
    },
    failWith(reason) {
      failure = reason;
    },
    documents(collection) {
      return [...coll(collection).values()];
    },
    get synonyms() {
      return state.synonyms;
    },
    get curations() {
      return state.curations;
    },
    get stems() {
      return state.stems;
    },
    get configWrites() {
      return state.writes;
    },
    clear() {
      store.clear();
      state.synonyms = [];
      state.curations = [];
      state.stems = [];
      broken = false;
      failure = null;
      state.calls = 0;
    },
  };
  return self;
}
