import 'server-only';
import { inArray, sql } from 'drizzle-orm';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { FOLD_WEIGHT, foldText, localizedFields, mergeRanked, noteIsolationDrop, pendingEntities, SEARCH_TIMEOUT_MS, searchAs, type SearchSpec, STOPWORD_SETS } from '@/modules/hdc/api';
import { tickets } from '../schema';

// Модуль hdt, слой core: текстовый поиск обращений через Typesense (план W6, задачи 5 и 8, решения 2, 4, 5, 14).
// Typesense отдаёт только идентификаторы и порядок; строки очереди и списка клиента читаются, как раньше, под
// актором через withActor по ticket_id = any(ids), и RLS отбрасывает чужое. null: Typesense выключен или не ответил,
// вызывающий ищет прежним containsText.

/** Сколько идентификаторов берётся из Typesense за раз (api/search: per_page до 250). */
export const TEXT_SEARCH_LIMIT = 250;

export type TextSearch = { ids: string[]; truncated: boolean };

const ticketFields = [...localizedFields('title'), ...localizedFields('description')];
const ticketWeights = [3, 3, 3, 1, 1, 1];

/** Вес списка переписки: совпадение в теме важнее совпадения в одном из сообщений. */
const TEXTS_WEIGHT = 0.8;

function specs(text: string, withTexts: boolean): { spec: SearchSpec; weight: number }[] {
  const folded = foldText(text);
  return [
    { spec: { collection: 'tickets', q: text, queryBy: ticketFields, queryByWeights: ticketWeights, perPage: TEXT_SEARCH_LIMIT, prefix: true, stopwords: STOPWORD_SETS }, weight: 1 },
    ...(folded ? [{ spec: { collection: 'tickets', q: folded, queryBy: ['title_fold'], perPage: TEXT_SEARCH_LIMIT, prefix: true } satisfies SearchSpec, weight: FOLD_WEIGHT }] : []),
    // Переписка и внутренние заметки (решение 0070, пункт 3): только сотруднику, одна строка на обращение.
    ...(withTexts
      ? [{ spec: { collection: 'ticket_texts', q: text, queryBy: localizedFields('body'), perPage: TEXT_SEARCH_LIMIT, prefix: true, groupBy: 'ticket_id' } satisfies SearchSpec, weight: TEXTS_WEIGHT }]
      : []),
  ];
}

async function run(actor: ClientActor | StaffActor, text: string, withTexts: boolean, timeoutMs: number): Promise<TextSearch | null> {
  const weighted = specs(text, withTexts);
  const res = await searchAs(actor, 'tickets', weighted.map((w) => w.spec), { timeoutMs });
  if (res.kind === 'fallback') return null;
  const ids = mergeRanked(res.results.map((r, i) => ({ hits: r.hits, weight: weighted[i]!.weight, key: ticketOf })));
  return { ids: ids.slice(0, TEXT_SEARCH_LIMIT), truncated: ids.length > TEXT_SEARCH_LIMIT || res.results.some((r) => r.found > TEXT_SEARCH_LIMIT) };
}

/** Обращение по идентификатору документа переписки <обращение>_<сообщение>. */
const ticketOf = (id: string) => id.split('_')[0] ?? id;

/** Сотрудник: обращения по теме, описанию, переписке и заметкам, до 250 лучших. */
export function staffTextSearch(actor: StaffActor, text: string): Promise<TextSearch | null> {
  return run(actor, text, true, SEARCH_TIMEOUT_MS.staffQueues);
}

const SYSTEM: SystemActor = { type: 'system', job: 'search.isolation' };

/**
 * Клиент: обращения своей организации (фильтр вложен в ключ). Без переписки: клиентский ключ её не видит. Проверку
 * после (RLS) делает вызывающий, отброшенное считает noteClientDrops.
 */
export async function clientTextSearch(actor: ClientActor, text: string): Promise<TextSearch | null> {
  const found = await run(actor, text, false, SEARCH_TIMEOUT_MS.client);
  // Больше 250 совпадений: лучшие 250 не дают листать дальше. Прежний путь (часть текста под RLS) отдаёт все.
  return found && !found.truncated ? found : null;
}

/**
 * Идентификаторы, которые Typesense дал клиенту, а RLS не отдал. Личное обращение коллеги отбрасывается законно;
 * обращение другой организации значит, что фильтр ключа сломан (решение 2): событие и сигнал search_isolation.
 */
export async function noteClientDrops(actor: ClientActor, ids: readonly string[], visible: ReadonlySet<string>): Promise<number> {
  const dropped = ids.filter((id) => !visible.has(id));
  if (dropped.length === 0) return 0;
  const rows = await withActor(SYSTEM, (tx) => tx.select({ id: tickets.ticketId, orgId: tickets.orgId }).from(tickets).where(inArray(tickets.ticketId, dropped)));
  const foreignIds = rows.filter((row) => row.orgId !== actor.orgId).map((row) => row.id);
  // Обращение перенесли в другую организацию секунды назад, строка очереди индекса ещё ждёт: это задержка, не утечка.
  const pending = await pendingEntities(SYSTEM, 'ticket', foreignIds);
  const foreign = foreignIds.filter((id) => !pending.has(id)).length;
  await noteIsolationDrop('tickets', foreign);
  return foreign;
}

/** Обращения из списка, которые актор видит: проверка после для клиента. */
export async function visibleTicketIds(actor: ClientActor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await withActor(actor, (tx) => tx.select({ id: tickets.ticketId }).from(tickets).where(sql`${tickets.ticketId} = any(${sql.param([...ids])}::uuid[])`));
  return new Set(rows.map((r) => r.id));
}
