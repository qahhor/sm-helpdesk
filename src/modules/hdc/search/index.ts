import 'server-only';
import { and, eq, gt } from 'drizzle-orm';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { env, parseSearchWriteEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { consumeRateLimit } from '../rate-limit';
import { rateLimits } from '../schema';
import { createPostgresReader } from './postgres';
import { type ParentSearchKeys, scopeFor } from './scoped-key';
import { createStubSearch, type StubSearch } from './stub';
import { createTypesenseReader, createTypesenseWriter } from './typesense';
import type { SearchCollection, SearchFallback, SearchIds, SearchIndexWriter, SearchPurpose, SearchReader, SearchSpec } from './types';

// Выбор реализации поиска по окружению (план W6, решение 15) и общий вызов от имени актора с откатом (решение 14).
// Портал получает только SearchReader (ключи поиска); SearchIndexWriter строит фоновый процесс и команда hub по
// parseSearchWriteEnv (ключ записи). Заглушка одна на процесс: тесты пишут и ищут в ней же.

let readerOverride: SearchReader | null = null;
let writerOverride: SearchIndexWriter | null = null;
let real: SearchReader | undefined;
let stub: StubSearch | undefined;

/** Заглушка процесса: общая для чтения и записи. */
export function processStub(): StubSearch {
  return (stub ??= createStubSearch());
}

function parentKeys(): ParentSearchKeys {
  if (env.SEARCH_PROVIDER === 'stub') return { client: 'stub-client-search-key', staff: 'stub-staff-search-key' };
  return { client: env.TYPESENSE_SEARCH_KEY ?? '', staff: env.TYPESENSE_STAFF_SEARCH_KEY ?? '' };
}

export function getSearchReader(): SearchReader {
  if (readerOverride) return readerOverride;
  return (real ??=
    env.SEARCH_PROVIDER === 'typesense' && env.TYPESENSE_URL ? createTypesenseReader({ url: env.TYPESENSE_URL }) : env.SEARCH_PROVIDER === 'stub' ? processStub() : createPostgresReader());
}

/** Запись индекса: фоновый процесс и команда hub. null: поиск идёт через PostgreSQL, писать некуда. */
export function getSearchWriter(source: Record<string, string | undefined> = process.env): SearchIndexWriter | null {
  if (writerOverride) return writerOverride;
  const cfg = parseSearchWriteEnv(source);
  if (cfg.mode === 'typesense') return createTypesenseWriter({ url: cfg.url, key: cfg.key });
  if (cfg.mode === 'stub') return processStub();
  return null;
}

/** Тесты подменяют чтение и запись (null возвращает настоящие). */
export function setSearchForTests(reader: SearchReader | null, writer: SearchIndexWriter | null = null): void {
  readerOverride = reader;
  writerOverride = writer;
}

/** Ключи с областью в тестах: заглушка принимает любые родительские ключи. */
let keysOverride: ParentSearchKeys | null = null;
export function setSearchKeysForTests(keys: ParentSearchKeys | null): void {
  keysOverride = keys;
}

const SYSTEM: SystemActor = { type: 'system', job: 'search.health' };
const FALLBACK_COUNTER = 'ops:search-fallbacks';
const ISOLATION_COUNTER = 'ops:search-isolation';
/** Окно счёта откатов и отброшенных идентификаторов: час (решение 14, сигнал search_unavailable). */
export const SEARCH_COUNTER_WINDOW_SEC = 3600;
const COUNTER_RULE = { limit: 2_000_000_000, windowSec: SEARCH_COUNTER_WINDOW_SEC };

async function count(code: string): Promise<void> {
  try {
    await consumeRateLimit(code, COUNTER_RULE);
  } catch {
    // Счётчик не должен ронять поиск: сбой базы здесь значит, что упадёт и сам запрос строк.
  }
}

/**
 * Поиск от имени актора: ключ с областью из актора, ожидание по вызову, откат с событием search.fallback без текста
 * (коллекция, причина, время). Отключённый поиск (SEARCH_PROVIDER=postgres) откатом не считается.
 */
export async function searchAs(
  actor: ClientActor | StaffActor,
  purpose: SearchPurpose,
  searches: readonly SearchSpec[],
  opts: { timeoutMs: number },
): Promise<SearchIds | SearchFallback> {
  const reader = getSearchReader();
  if (reader.name === 'postgres') return { kind: 'fallback', reason: 'disabled' };
  const keys = keysOverride ?? parentKeys();
  if (!keys.client || !keys.staff) return { kind: 'fallback', reason: 'no_key' };
  const started = performance.now();
  const result = await reader.searchIds(scopeFor(actor, purpose, keys), searches, opts);
  if (result.kind === 'fallback') {
    logEvent('warn', 'search.fallback', { collection: searches[0]?.collection ?? purpose, reason: result.reason, ms: Math.round(performance.now() - started) });
    await count(FALLBACK_COUNTER);
  }
  return result;
}

/**
 * Клиент получил из Typesense идентификатор, которого RLS ему не отдал, а по данным это чужая строка (решение 2):
 * событие без текста и счётчик, ops.watch поднимает сигнал search_isolation.
 */
export async function noteIsolationDrop(collection: SearchCollection, dropped: number): Promise<void> {
  if (dropped <= 0) return;
  logEvent('error', 'search.isolation_drop', { collection, count: dropped });
  await count(ISOLATION_COUNTER);
}

/** Откаты и отброшенные идентификаторы в текущем часовом окне: для ops.watch. */
export async function searchCounters(actor: SystemActor = SYSTEM, now: Date = new Date()): Promise<{ fallbacks: number; isolationDrops: number }> {
  const since = new Date(now.getTime() - SEARCH_COUNTER_WINDOW_SEC * 1000);
  const read = async (code: string) => {
    const rows = await withActor(actor, (tx) => tx.select({ hits: rateLimits.hits }).from(rateLimits).where(and(eq(rateLimits.code, code), gt(rateLimits.windowOn, since))));
    return rows[0]?.hits ?? 0;
  };
  const [fallbacks, isolationDrops] = await Promise.all([read(FALLBACK_COUNTER), read(ISOLATION_COUNTER)]);
  return { fallbacks, isolationDrops };
}

export { foldText } from './fold';
export { HIDDEN_IDEA_STATUSES, isScopedKey, scopeFor } from './scoped-key';
export { createStubSearch, type StubSearch } from './stub';
export { COLLECTION_SCHEMAS, localeField, localizedFields, STOPWORD_SETS, TEXT_LIMITS } from './collections';
export { filterValues } from './typesense';
export { FOLD_WEIGHT, mergeRanked, type RankedList, RRF_K, SEARCH_TIMEOUT_MS } from './rank';
export * from './types';
