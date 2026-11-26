import 'server-only';
import * as z from 'zod';
import { type Breaker, createBreaker } from './breaker';
import { COLLECTION_SCHEMAS, CURATION_SET, STOPWORD_SETS, STOPWORDS, SYNONYM_SET, UZ_STEMS } from './collections';
import { foldText } from './fold';
import { isScopedKey } from './scoped-key';
import {
  aliasOf,
  type CollectionInfo,
  type CurationItem,
  SEARCH_COLLECTIONS,
  type ScopedKey,
  type SearchCollection,
  type SearchFailure,
  type SearchFallback,
  type SearchHitId,
  type SearchIds,
  type SearchIndexWriter,
  type SearchReader,
  type SearchResult,
  type SearchSpec,
  SearchWriteError,
  type StemPair,
  type SynonymItem,
} from './types';

// Клиент Typesense 30.2 на fetch (план W6, решения 2, 3, 14; документация api/search, api/federated-multi-search,
// api/documents, api/collections, api/collection-alias, api/synonyms, api/curation, api/stemming,
// api/cluster-operations). Адрес внутренний (проверяет src/env.ts), поэтому вызов идёт обычным fetch мимо защиты
// исходящих запросов, как у TEI. Портал ищет только ключом с областью (ScopedKey); ключ записи есть только у фонового
// процесса и команды hub. Каждый поиск несёт use_cache: false, include_fields: id и highlight_fields: none явно, хотя
// они вложены и в ключ. Ответ проверяется схемой; любой сбой, ожидание дольше заданного и открытый выключатель дают
// Fallback. В ошибках только код: ни текста запроса, ни документов, ни ключа.

const hit = z.object({
  document: z.object({ id: z.string().min(1).max(200) }),
  text_match: z.number().optional(),
  text_match_info: z.object({ tokens_matched: z.number().int().nonnegative() }).passthrough().optional(),
});

const result = z.union([
  z.object({ error: z.string(), code: z.number().int() }).passthrough(),
  z
    .object({
      found: z.number().int().nonnegative(),
      hits: z.array(hit).optional(),
      grouped_hits: z.array(z.object({ hits: z.array(hit) }).passthrough()).optional(),
    })
    .passthrough(),
]);

const multiResponse = z.object({ results: z.array(result) });

/** Значение в условии filter_by: только знаки идентификаторов, кодов и языков. */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,200}$/;

export function filterValues(values: readonly string[]): string {
  for (const value of values) if (!SAFE_VALUE.test(value)) throw new Error('Поиск: недопустимое значение в условии');
  return `[${values.join(',')}]`;
}

function searchParams(spec: SearchSpec): Record<string, unknown> {
  return {
    collection: aliasOf(spec.collection),
    q: spec.q,
    query_by: spec.queryBy.join(','),
    ...(spec.queryByWeights ? { query_by_weights: spec.queryByWeights.join(',') } : {}),
    ...(spec.filterBy ? { filter_by: spec.filterBy } : {}),
    ...(spec.groupBy ? { group_by: spec.groupBy, group_limit: 1 } : {}),
    ...(spec.infix ? { infix: spec.infix.join(',') } : {}),
    ...(spec.stopwords ? { stopwords: spec.stopwords } : {}),
    prefix: spec.prefix ?? false,
    num_typos: spec.numTypos ?? 2,
    split_join_tokens: spec.splitJoinTokens ?? 'fallback',
    ...(spec.dropTokensThreshold !== undefined ? { drop_tokens_threshold: spec.dropTokensThreshold } : {}),
    ...(spec.typoTokensThreshold !== undefined ? { typo_tokens_threshold: spec.typoTokensThreshold } : {}),
    // Номер SUP-1042 не должен находить 1043 (решение 7).
    enable_typos_for_numerical_tokens: false,
    enable_typos_for_alpha_numerical_tokens: false,
    // Синонимы не срабатывают на исправленных опечатках и стоят ниже прямых совпадений (решение 9).
    synonym_num_typos: 0,
    demote_synonym_match: true,
    per_page: Math.min(250, Math.max(1, spec.perPage)),
    page: 1,
    include_fields: 'id',
    highlight_fields: 'none',
    use_cache: false,
  };
}

function hitOf(h: z.infer<typeof hit>): SearchHitId {
  return { id: h.document.id, textMatch: h.text_match ?? 0, tokensMatched: h.text_match_info?.tokens_matched ?? 0 };
}

/**
 * Синоним без locale Typesense 30.2 применяет только к полям без locale (проверено: "склад" не находил "ombor" в поле
 * с locale uz). Поэтому каждая запись уходит копией на каждый язык полей и копией без языка для полей *_fold, слова
 * которой свёрнуты той же функцией, что и запрос к этим полям.
 */
export function expandSynonyms(items: readonly SynonymItem[]): SynonymItem[] {
  return items.flatMap((item) => {
    const folded = [...new Set(item.synonyms.map(foldText).filter(Boolean))];
    const foldedRoot = item.root ? foldText(item.root) : undefined;
    return [
      ...(['ru', 'en', 'uz'] as const).map((locale) => ({ ...item, id: `${item.id}_${locale}`, locale })),
      ...(folded.length > 1 || (foldedRoot && folded.length > 0) ? [{ id: `${item.id}_fold`, synonyms: folded, ...(foldedRoot ? { root: foldedRoot } : {}) }] : []),
    ];
  });
}

export type TypesenseConfig = { url: string; fetch?: typeof fetch; breaker?: Breaker };

/** Одна общая точка состояния выключателя на процесс. */
const processBreaker = createBreaker();

export function createTypesenseReader(cfg: TypesenseConfig): SearchReader & { breaker: Breaker } {
  const endpoint = `${cfg.url.replace(/\/+$/, '')}/multi_search`;
  const send = cfg.fetch ?? fetch;
  const breaker = cfg.breaker ?? processBreaker;
  const fail = (reason: SearchFailure): SearchFallback => {
    breaker.failure();
    return { kind: 'fallback', reason };
  };
  return {
    name: 'typesense',
    breaker,
    async searchIds(scope: ScopedKey, searches: readonly SearchSpec[], opts: { timeoutMs: number }): Promise<SearchIds | SearchFallback> {
      // Ключ без области и поиск вне области ключа это ошибка кода, а не сбой Typesense: бросается, а не откатывается.
      if (!isScopedKey(scope)) throw new Error('Поиск: ключ без области не принимается');
      for (const spec of searches) if (!scope.collections.includes(spec.collection)) throw new Error('Поиск: коллекция вне области ключа');
      if (searches.length === 0) return { kind: 'ids', results: [] };
      if (breaker.isOpen()) return { kind: 'fallback', reason: 'breaker_open' };
      const signal = AbortSignal.timeout(opts.timeoutMs);
      let res: Response;
      try {
        res = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-typesense-api-key': scope.value },
          body: JSON.stringify({ searches: searches.map(searchParams) }),
          signal,
        });
      } catch {
        return fail(signal.aborted ? 'timeout' : 'unreachable');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return fail(`http_${res.status}`);
      }
      let parsed: z.infer<typeof multiResponse>;
      try {
        parsed = multiResponse.parse(await res.json());
      } catch {
        return fail(signal.aborted ? 'timeout' : 'invalid_response');
      }
      if (parsed.results.length !== searches.length) return fail('invalid_response');
      const results: SearchResult[] = [];
      for (const r of parsed.results) {
        if ('error' in r && typeof r.error === 'string') return fail(`http_${typeof r.code === 'number' ? r.code : 500}`);
        const ok = r as { found: number; hits?: z.infer<typeof hit>[]; grouped_hits?: { hits: z.infer<typeof hit>[] }[] };
        const hits = ok.grouped_hits ? ok.grouped_hits.flatMap((group) => (group.hits[0] ? [hitOf(group.hits[0])] : [])) : (ok.hits ?? []).map(hitOf);
        results.push({ hits, found: ok.found });
      }
      breaker.success();
      return { kind: 'ids', results };
    },
  };
}

// --- Запись: фоновый процесс и команда hub (ключ записи) ---

const WRITE_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 120_000;
const BATCH_IDS = 100;

export function createTypesenseWriter(cfg: { url: string; key: string; fetch?: typeof fetch }): SearchIndexWriter {
  const base = cfg.url.replace(/\/+$/, '');
  const send = cfg.fetch ?? fetch;

  async function call(method: string, path: string, opts: { body?: unknown; ndjson?: string; timeoutMs?: number; allow404?: boolean } = {}): Promise<{ status: number; text: string }> {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? WRITE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await send(`${base}${path}`, {
        method,
        headers: { 'x-typesense-api-key': cfg.key, 'content-type': opts.ndjson !== undefined ? 'text/plain' : 'application/json' },
        ...(opts.ndjson !== undefined ? { body: opts.ndjson } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      });
    } catch {
      throw new SearchWriteError(signal.aborted ? 'timeout' : 'unreachable');
    }
    const text = await res.text().catch(() => '');
    if (res.status === 404 && opts.allow404) return { status: 404, text };
    if (!res.ok) throw new SearchWriteError(`http_${res.status}`);
    return { status: res.status, text };
  }

  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new SearchWriteError('invalid_response');
    }
  };

  const nameOf = (target: SearchCollection | { name: string }) => (typeof target === 'string' ? aliasOf(target) : target.name);

  async function createVersion(collection: SearchCollection, version: number): Promise<string> {
    const name = `${aliasOf(collection)}_v${version}`;
    const schema = COLLECTION_SCHEMAS[collection];
    await call('POST', '/collections', { body: { name, ...schema } });
    return name;
  }

  async function currentVersions(name: string, ids: readonly string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 250) {
      const chunk = ids.slice(i, i + 250);
      const params = new URLSearchParams({ q: '*', filter_by: `id:${filterValues(chunk)}`, include_fields: 'id,version', per_page: '250', use_cache: 'false' });
      const { text } = await call('GET', `/collections/${name}/documents/search?${params}`);
      const parsed = z.object({ hits: z.array(z.object({ document: z.object({ id: z.string(), version: z.number().optional() }) })) }).safeParse(json(text));
      if (!parsed.success) throw new SearchWriteError('invalid_response');
      for (const h of parsed.data.hits) found.set(h.document.id, h.document.version ?? 0);
    }
    return found;
  }

  return {
    name: 'typesense',
    async ensureCollections() {
      // Словарь и наборы до коллекций: схема ссылается на них по имени.
      if ((await call('GET', `/stemming/dictionaries/${UZ_STEMS}`, { allow404: true })).status === 404)
        await call('POST', `/stemming/dictionaries/import?id=${UZ_STEMS}`, { ndjson: JSON.stringify({ word: 'hubhub', root: 'hubhub' }) });
      if ((await call('GET', `/synonym_sets/${SYNONYM_SET}`, { allow404: true })).status === 404) await call('PUT', `/synonym_sets/${SYNONYM_SET}`, { body: { items: [] } });
      if ((await call('GET', `/curation_sets/${CURATION_SET}`, { allow404: true })).status === 404) await call('PUT', `/curation_sets/${CURATION_SET}`, { body: { items: [] } });
      await call('PUT', `/stopwords/${STOPWORD_SETS}`, { body: { stopwords: Object.values(STOPWORDS).flat(), locale: 'ru' } });
      const existing = new Set((await this.listCollections()).map((c) => c.name));
      for (const collection of SEARCH_COLLECTIONS) {
        if (await this.aliasTarget(collection)) continue;
        const name = `${aliasOf(collection)}_v1`;
        if (!existing.has(name)) await createVersion(collection, 1);
        await call('PUT', `/aliases/${aliasOf(collection)}`, { body: { collection_name: name } });
      }
    },
    async upsert(target, docs) {
      if (docs.length === 0) return;
      const name = nameOf(target);
      // Старшая версия в индексе не перезаписывается младшей (решение 11): пачка, прочитанная раньше, не затирает
      // более позднюю, даже если запись дошла позже.
      const known = typeof target === 'string' ? await currentVersions(name, docs.map((d) => d.id)) : new Map<string, number>();
      const fresh = docs.filter((d) => (known.get(d.id) ?? -1) <= d.version);
      if (fresh.length === 0) return;
      const { text } = await call('POST', `/collections/${name}/documents/import?action=upsert`, { ndjson: fresh.map((d) => JSON.stringify(d)).join('\n'), timeoutMs: IMPORT_TIMEOUT_MS });
      const failed = text.split('\n').filter((line) => line.trim() && !line.includes('"success":true')).length;
      if (failed > 0) throw new SearchWriteError('import_failed');
    },
    async remove(collection, ids) {
      for (let i = 0; i < ids.length; i += BATCH_IDS)
        await call('DELETE', `/collections/${aliasOf(collection)}/documents?${new URLSearchParams({ filter_by: `id:${filterValues(ids.slice(i, i + BATCH_IDS))}` })}`);
    },
    async removeWhere(collection, filterBy) {
      await call('DELETE', `/collections/${aliasOf(collection)}/documents?${new URLSearchParams({ filter_by: filterBy })}`);
    },
    async exportDocs(collection) {
      const { text } = await call('GET', `/collections/${aliasOf(collection)}/documents/export?include_fields=id,version,content_hash`, { timeoutMs: IMPORT_TIMEOUT_MS });
      const out = new Map<string, { version: number; hash: string | null }>();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const row = json(line) as { id?: unknown; version?: unknown; content_hash?: unknown };
        if (typeof row.id === 'string') out.set(row.id, { version: typeof row.version === 'number' ? row.version : 0, hash: typeof row.content_hash === 'string' ? row.content_hash : null });
      }
      return out;
    },
    async putSynonyms(items: readonly SynonymItem[]) {
      await call('PUT', `/synonym_sets/${SYNONYM_SET}`, { body: { items: expandSynonyms(items) } });
    },
    async putCurations(items: readonly CurationItem[]) {
      await call('PUT', `/curation_sets/${CURATION_SET}`, {
        body: { items: items.map((item) => ({ id: item.id, rule: { query: item.query, match: item.match }, includes: item.includes })) },
      });
    },
    async putStems(pairs: readonly StemPair[]) {
      // Импорт словаря добавляет пары к прежним, а коллекция берёт словарь при создании (проверено на 30.2): словарь
      // пересоздаётся целиком, новые пары действуют в коллекциях, созданных после этого (переиндексация).
      await call('DELETE', `/stemming/dictionaries/${UZ_STEMS}`, { allow404: true });
      const lines = (pairs.length > 0 ? pairs : [{ word: 'hubhub', root: 'hubhub' }]).map((pair) => JSON.stringify(pair)).join('\n');
      await call('POST', `/stemming/dictionaries/import?id=${UZ_STEMS}`, { ndjson: lines });
    },
    async listCollections(): Promise<CollectionInfo[]> {
      const parsed = z.array(z.object({ name: z.string(), num_documents: z.number(), created_at: z.number() }).passthrough()).safeParse(json((await call('GET', '/collections')).text));
      if (!parsed.success) throw new SearchWriteError('invalid_response');
      return parsed.data.map((c) => ({ name: c.name, numDocuments: c.num_documents, createdAt: c.created_at }));
    },
    async aliasTarget(collection) {
      const res = await call('GET', `/aliases/${aliasOf(collection)}`, { allow404: true });
      if (res.status === 404) return null;
      const parsed = z.object({ collection_name: z.string() }).safeParse(json(res.text));
      return parsed.success ? parsed.data.collection_name : null;
    },
    createVersion,
    async switchAlias(collection, name) {
      await call('PUT', `/aliases/${aliasOf(collection)}`, { body: { collection_name: name } });
    },
    async dropCollection(name) {
      if (!/^hub_[a-z_]+_v\d{1,6}$/.test(name)) throw new SearchWriteError('invalid_name');
      await call('DELETE', `/collections/${name}`, { allow404: true });
    },
    async health() {
      try {
        const res = await send(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
        return res.ok && body?.ok === true;
      } catch {
        return false;
      }
    },
    async memory() {
      try {
        const parsed = z
          .object({ typesense_memory_active_bytes: z.coerce.number(), system_memory_total_bytes: z.coerce.number() })
          .passthrough()
          .safeParse(json((await call('GET', '/metrics.json', { timeoutMs: 5000 })).text));
        return parsed.success ? { usedBytes: parsed.data.typesense_memory_active_bytes, totalBytes: parsed.data.system_memory_total_bytes } : null;
      } catch {
        return null;
      }
    },
  };
}
