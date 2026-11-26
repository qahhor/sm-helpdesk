import 'server-only';
import { and, asc, count, eq, inArray, lt, lte, min } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { writeAudit } from '../audit';
import { type SearchEntityKind, searchOutbox } from '../schema';
import { readSetting } from '../settings';
import { curationSchema, type CurationRules, SEARCH_SETTING_CODES, stemDictionary, stemPairsSchema, synonymItems, synonymSetsSchema } from './config';
import { filterValues } from './typesense';
import { type CurationItem, type SearchCollection, type SearchDocument, type SearchIndexWriter, SearchWriteError } from './types';

// Задачи индекса поиска (план W6, решения 10-12): search.sync разбирает очередь hdc_search_outbox, search.reconcile
// сверяет индекс с PostgreSQL, hub search:reindex строит коллекцию заново. Документы строят модули-владельцы
// (hdt, hdk, hdi, hdu) в своём слое api и отдают их фоновому процессу через registerSearchSources: ядро не знает
// их таблиц. Актуальные строки читаются в момент записи, поэтому повторы одного объекта схлопываются в одну запись,
// а старшая версия в индексе не перезаписывается младшей (SearchIndexWriter.upsert).

export type SourceKind = Exclude<SearchEntityKind, 'config'>;

/** Источник документов одного вида: строит модуль-владелец под системным актором. */
export type SearchSource = {
  collection: SearchCollection;
  /**
   * Документы объектов. Нет объекта, он в архиве или не виден (черновик, идея на модерации): пустой список, и его
   * документы удаляются из индекса.
   */
  build(system: SystemActor, ids: readonly string[]): Promise<Map<string, SearchDocument[]>>;
  /** Поле документа с идентификатором объекта, если документов на объект несколько (языки решения и идеи). */
  ownerField?: string;
  /** Идентификаторы всех объектов по возрастанию, страницами: переиндексация. */
  pageIds(system: SystemActor, after: string | null, limit: number): Promise<string[]>;
  /** Что ещё убрать вместе с удалённым объектом (переписка удалённого обращения). */
  afterRemove?(writer: SearchIndexWriter, ids: readonly string[]): Promise<void>;
};

/** Правила курирования в идентификаторы документов опубликованных решений: даёт hdk. */
export type CurationResolver = (system: SystemActor, rules: CurationRules['rules']) => Promise<CurationItem[]>;

const sources = new Map<SourceKind, SearchSource>();
let curationResolver: CurationResolver | null = null;

/** Источники регистрирует фоновый процесс и команда hub (src/worker/search.ts). */
export function registerSearchSources(map: Partial<Record<SourceKind, SearchSource>>, curations?: CurationResolver): void {
  for (const [kind, source] of Object.entries(map) as [SourceKind, SearchSource][]) sources.set(kind, source);
  if (curations) curationResolver = curations;
}

export function searchSource(kind: SourceKind): SearchSource | undefined {
  return sources.get(kind);
}

export const KIND_OF: Record<SearchCollection, SourceKind> = {
  tickets: 'ticket',
  ticket_texts: 'ticket_text',
  solutions: 'solution',
  ideas: 'idea',
  orgs: 'org',
  people: 'person',
};

/** Паузы перед повтором после 1-4 сбоя, секунд (решение 11). После пятого строку чинит ночная сверка. */
export const SYNC_RETRY_SECONDS = [10, 60, 300, 900] as const;
export const SYNC_MAX_ATTEMPTS = 5;
/** Срок захвата строки задачей: если процесс упал посреди записи, строку возьмёт следующий запуск. */
const LEASE_SECONDS = 300;
const BATCH = 500;

/** Пишет документы объектов одного вида: удаляет исчезнувшие и прежние языки, затем пачка upsert. */
export async function applyEntities(system: SystemActor, writer: SearchIndexWriter, kind: SourceKind, ids: readonly string[], target?: { name: string }): Promise<{ upserted: number; removed: number }> {
  const source = sources.get(kind);
  if (!source) throw new SearchWriteError('no_source');
  const built = await source.build(system, ids);
  const docs = [...built.values()].flat();
  const gone = ids.filter((id) => (built.get(id) ?? []).length === 0);
  if (!target) {
    if (source.ownerField) {
      // Решение и идея: строка на язык. Прежние языки, которых больше нет, уходят до записи новых.
      const keep = docs.map((d) => d.id);
      const filter = `${source.ownerField}:=${filterValues(ids)}${keep.length > 0 ? ` && id:!=${filterValues(keep)}` : ''}`;
      if (ids.length > 0) await writer.removeWhere(source.collection, filter);
    } else if (gone.length > 0) {
      await writer.remove(source.collection, gone);
    }
    if (gone.length > 0) await source.afterRemove?.(writer, gone);
  }
  await writer.upsert(target ?? source.collection, docs);
  return { upserted: docs.length, removed: gone.length };
}

type Claimed = { outboxId: string; entityKind: SearchEntityKind; entityId: string; attempts: number };

async function claim(system: SystemActor, now: Date, batch: number): Promise<Claimed[]> {
  return withActor(system, async (tx) => {
    const rows = await tx
      .select({ outboxId: searchOutbox.outboxId, entityKind: searchOutbox.entityKind, entityId: searchOutbox.entityId, attempts: searchOutbox.attempts })
      .from(searchOutbox)
      .where(and(lt(searchOutbox.attempts, SYNC_MAX_ATTEMPTS), lte(searchOutbox.nextAttemptOn, now)))
      .orderBy(asc(searchOutbox.nextAttemptOn), asc(searchOutbox.outboxId))
      .limit(batch)
      .for('update', { skipLocked: true });
    if (rows.length > 0)
      await tx
        .update(searchOutbox)
        .set({ nextAttemptOn: new Date(now.getTime() + LEASE_SECONDS * 1000) })
        .where(inArray(searchOutbox.outboxId, rows.map((r) => r.outboxId)));
    return rows;
  });
}

async function done(system: SystemActor, rows: readonly Claimed[]): Promise<void> {
  if (rows.length === 0) return;
  await withActor(system, (tx) => tx.delete(searchOutbox).where(inArray(searchOutbox.outboxId, rows.map((r) => r.outboxId))));
}

async function failed(system: SystemActor, rows: readonly Claimed[], code: string, now: Date): Promise<number> {
  let dropped = 0;
  await withActor(system, async (tx) => {
    for (const row of rows) {
      const attempts = row.attempts + 1;
      if (attempts >= SYNC_MAX_ATTEMPTS) dropped++;
      const pause = SYNC_RETRY_SECONDS[Math.min(row.attempts, SYNC_RETRY_SECONDS.length - 1)]!;
      await tx
        .update(searchOutbox)
        .set({ attempts, lastErrorCode: code.slice(0, 40), nextAttemptOn: new Date(now.getTime() + pause * 1000) })
        .where(eq(searchOutbox.outboxId, row.outboxId));
    }
  });
  return dropped;
}

const codeOf = (error: unknown) => (error instanceof SearchWriteError ? error.code : 'error').replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'error';

/** Синонимы, словарь и курирование из настроек в Typesense. Смена словаря требует новых коллекций решений и идей. */
async function applyConfig(system: SystemActor, writer: SearchIndexWriter, code: string): Promise<void> {
  const raw = await readSetting(code);
  if (code === SEARCH_SETTING_CODES.synonyms) {
    const parsed = synonymSetsSchema.safeParse(raw ?? { sets: [] });
    await writer.putSynonyms(parsed.success ? synonymItems(parsed.data) : []);
  } else if (code === SEARCH_SETTING_CODES.stems) {
    const parsed = stemPairsSchema.safeParse(raw ?? { pairs: [] });
    await writer.putStems(parsed.success ? stemDictionary(parsed.data) : []);
    // Коллекция берёт словарь при создании (решение 0080, пункт 6): решения и идеи строятся заново.
    for (const collection of ['solutions', 'ideas'] as const) if (sources.has(KIND_OF[collection])) await reindexCollection(system, writer, collection, { audit: false });
  } else if (code === SEARCH_SETTING_CODES.curation) {
    const parsed = curationSchema.safeParse(raw ?? { rules: [] });
    await writer.putCurations(parsed.success && curationResolver ? await curationResolver(system, parsed.data.rules) : []);
  }
}

export type SyncResult = { written: number; failed: number; dropped: number; cleared: number };

/**
 * Один проход очереди: до 500 строк, по видам, объект один раз. Без записи (SEARCH_PROVIDER=postgres) очередь
 * очищается: при включении Typesense индекс строится командой hub search:reindex.
 */
export async function runSearchSync(system: SystemActor, writer: SearchIndexWriter | null, opts: { now?: Date; batch?: number } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  if (!writer) {
    const cleared = await withActor(system, async (tx) => (await tx.delete(searchOutbox).returning({ id: searchOutbox.outboxId })).length);
    return { written: 0, failed: 0, dropped: 0, cleared };
  }
  const rows = await claim(system, now, opts.batch ?? BATCH);
  const result: SyncResult = { written: 0, failed: 0, dropped: 0, cleared: 0 };
  const byKind = new Map<SearchEntityKind, Claimed[]>();
  for (const row of rows) byKind.set(row.entityKind, [...(byKind.get(row.entityKind) ?? []), row]);
  for (const [kind, group] of byKind) {
    const ids = [...new Set(group.map((r) => r.entityId))];
    try {
      if (kind === 'config') for (const code of ids) await applyConfig(system, writer, code);
      else await applyEntities(system, writer, kind, ids);
      await done(system, group);
      result.written += ids.length;
    } catch (error) {
      const code = codeOf(error);
      const dropped = await failed(system, group, code, now);
      result.failed += group.length;
      result.dropped += dropped;
      // Без текста и идентификаторов: вид, число и код сбоя.
      logEvent(dropped > 0 ? 'error' : 'warn', 'search.sync_failed', { kind, count: group.length, dropped, code });
    }
  }
  return result;
}

/** Очередь для наблюдения: ждущие, после пятого сбоя, возраст самой старой ждущей строки. */
export async function searchQueueState(system: SystemActor, now: Date = new Date()): Promise<{ pending: number; dropped: number; lagSec: number }> {
  return withActor(system, async (tx) => {
    const [pending] = await tx.select({ n: count(), oldest: min(searchOutbox.createdOn) }).from(searchOutbox).where(lt(searchOutbox.attempts, SYNC_MAX_ATTEMPTS));
    const [dead] = await tx.select({ n: count() }).from(searchOutbox).where(eq(searchOutbox.attempts, SYNC_MAX_ATTEMPTS));
    const oldest = pending?.oldest ? new Date(pending.oldest) : null;
    return { pending: Number(pending?.n ?? 0), dropped: Number(dead?.n ?? 0), lagSec: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : 0 };
  });
}

/** Ждёт ли объект записи в индекс: отброшенный у клиента идентификатор в эту задержку событием изоляции не считается. */
export async function pendingEntities(system: SystemActor, kind: SourceKind, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await withActor(system, (tx) =>
    tx
      .select({ id: searchOutbox.entityId })
      .from(searchOutbox)
      .where(and(eq(searchOutbox.entityKind, kind), inArray(searchOutbox.entityId, [...ids]))),
  );
  return new Set(rows.map((r) => r.id));
}

/** Ставит объекты в очередь вручную: сверка, после переиндексации. */
export async function enqueueEntities(system: SystemActor, kind: SearchEntityKind, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000)
    await withActor(system, (tx) => tx.insert(searchOutbox).values(ids.slice(i, i + 1000).map((entityId) => ({ entityKind: kind, entityId }))));
}

// --- Сверка (решение 12) ---

/** Расхождение больше этой доли документов даёт сигнал search_drift. */
export const DRIFT_ALERT_SHARE = 0.001;
/** Коллекция без псевдонима старше суток удаляется сверкой (прежняя версия после переиндексации). */
const OLD_VERSION_TTL_SEC = 24 * 3600;

export type ReconcileReport = { collection: SearchCollection; expected: number; indexed: number; missing: number; stale: number; extra: number; drift: number };

/**
 * Сверка коллекции с PostgreSQL: идентификаторы и версии всех документов. Недостающие и устаревшие объекты
 * ставятся в очередь, лишние документы удаляются сразу. Ожидаемые версии строит источник тем же build, что и запись.
 */
export async function reconcileCollection(system: SystemActor, writer: SearchIndexWriter, collection: SearchCollection, opts: { pageSize?: number } = {}): Promise<ReconcileReport> {
  const kind = KIND_OF[collection];
  const source = sources.get(kind);
  if (!source) throw new SearchWriteError('no_source');
  const indexed = await writer.exportVersions(collection);
  const expected = new Map<string, number>();
  const queue = new Set<string>();
  let missing = 0;
  let stale = 0;
  let after: string | null = null;
  for (;;) {
    const ids = await source.pageIds(system, after, opts.pageSize ?? 2000);
    if (ids.length === 0) break;
    after = ids[ids.length - 1]!;
    const built = await source.build(system, ids);
    for (const [entity, docs] of built)
      for (const doc of docs) {
        expected.set(doc.id, doc.version);
        const have = indexed.get(doc.id);
        if (have === undefined) missing++;
        else if (have < doc.version) stale++;
        else continue;
        queue.add(entity);
      }
  }
  const extra = [...indexed.keys()].filter((id) => !expected.has(id));
  if (extra.length > 0) await writer.remove(collection, extra);
  if (queue.size > 0) await enqueueEntities(system, kind, [...queue]);
  // Прежние версии коллекции после переиндексации: удаляются через сутки.
  const live = await writer.aliasTarget(collection);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const c of await writer.listCollections())
    if (c.name !== live && c.name.startsWith(`hub_${collection}_v`) && nowSec - c.createdAt > OLD_VERSION_TTL_SEC) await writer.dropCollection(c.name);
  const drift = (missing + stale + extra.length) / Math.max(1, expected.size);
  return { collection, expected: expected.size, indexed: indexed.size, missing, stale, extra: extra.length, drift };
}

// --- Переиндексация (решение 12) ---

/**
 * Строит коллекцию hub_<имя>_v<N+1> пачками, переключает псевдоним, затем сверяет: изменения, пришедшие во время
 * заливки в прежнюю коллекцию, сверка ставит в очередь. Прежняя версия удаляется сверкой через сутки.
 */
export async function reindexCollection(system: SystemActor, writer: SearchIndexWriter, collection: SearchCollection, opts: { audit?: boolean; pageSize?: number } = {}): Promise<{ name: string; documents: number }> {
  const kind = KIND_OF[collection];
  const source = sources.get(kind);
  if (!source) throw new SearchWriteError('no_source');
  const current = await writer.aliasTarget(collection);
  const version = Number(/_v(\d+)$/.exec(current ?? '')?.[1] ?? 0) + 1;
  const name = await writer.createVersion(collection, version);
  let documents = 0;
  let after: string | null = null;
  for (;;) {
    const ids = await source.pageIds(system, after, opts.pageSize ?? 5000);
    if (ids.length === 0) break;
    after = ids[ids.length - 1]!;
    documents += (await applyEntities(system, writer, kind, ids, { name })).upserted;
  }
  await writer.switchAlias(collection, name);
  await reconcileCollection(system, writer, collection);
  if (opts.audit !== false)
    await withActor(system, (tx) => writeAudit(tx, { action: 'search.reindexed', objectType: 'search', objectId: collection, diff: { collection, version, documents } }));
  return { name, documents };
}

/** Строки очереди после пятого сбоя: сверка их уже учла, ночью они удаляются. */
export async function cleanupDroppedOutbox(system: SystemActor): Promise<number> {
  return withActor(system, async (tx) => (await tx.delete(searchOutbox).where(eq(searchOutbox.attempts, SYNC_MAX_ATTEMPTS)).returning({ id: searchOutbox.outboxId })).length);
}

