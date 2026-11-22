import 'server-only';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, ne, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { HdtError } from '../error';
import type { Priority, Queue, TicketStatus } from '../pref';
import { savedFilters, type SavedQuery, ticketMessages, tickets } from '../schema';
import { QUEUE_KEYS, type QueueKey, type QueueSort } from './agent-queue-keys';

// Модуль hdt, слой core: очереди рабочего места (FR-AG-01, FR-AG-10, FR-AG-14, FR-AG-18; план M3, задача 5).
// Читает сотрудник под своим актором: политики RLS отдают ему все обращения, а условия очереди задаёт код.

export { QUEUE_KEYS, QUEUE_SORTS, type QueueKey, type QueueSort } from './agent-queue-keys';

export type QueueSearch = { number?: number; text?: string; orgIds: string[]; authorIds: string[] };

export type QueueRecord = {
  ticketId: string;
  number: number;
  title: string;
  status: TicketStatus;
  priority: Priority;
  orgId: string;
  assigneeId: string | null;
  queue: Queue;
  createdOn: Date;
  firstRespondedOn: Date | null;
  dueOn: Date | null;
  snoozedUntil: Date | null;
  clientWaitingSince: Date | null;
};

const OPEN = notInArray(tickets.status, ['resolved', 'closed']);
/** Ближайший срок: первого ответа, пока его не было, иначе решения. */
const dueOn = sql<Date | null>`case when ${tickets.firstRespondedOn} is null then ${tickets.firstResponseDueOn} else ${tickets.resolutionDueOn} end`.mapWith(
  tickets.firstResponseDueOn,
);
/** Отложенное до своего времени (решение 13 плана M3). */
const notSnoozed = or(isNull(tickets.snoozedUntil), lt(tickets.snoozedUntil, sql`now()`)) as SQL;

/** Условие очереди: что в неё входит (FR-AG-01). */
function queueWhere(queue: QueueKey, me: string): SQL | undefined {
  switch (queue) {
    // Новые первой линии: переданное на вторую ждёт её в своей очереди (решение 0031, пункт 15).
    case 'new':
      return and(eq(tickets.status, 'new'), eq(tickets.queue, 'l1'), notSnoozed);
    case 'mine':
      return and(eq(tickets.assigneeId, me), ne(tickets.status, 'closed'));
    case 'l2':
      return and(eq(tickets.queue, 'l2'), OPEN, notSnoozed);
    case 'waiting':
      return and(eq(tickets.status, 'waiting_customer'), notSnoozed);
    case 'development':
      return and(eq(tickets.status, 'in_development'), notSnoozed);
    case 'breached':
      return and(
        OPEN,
        notSnoozed,
        or(
          isNotNull(tickets.firstResponseBreachedOn),
          isNotNull(tickets.resolutionBreachedOn),
          and(isNull(tickets.firstRespondedOn), lt(tickets.firstResponseDueOn, sql`now()`)),
          and(ne(tickets.status, 'waiting_customer'), lt(tickets.resolutionDueOn, sql`now()`)),
        ),
      );
    case 'all':
      return undefined;
  }
}

const likeText = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Поиск (FR-AG-10): номер, текст темы и описания, организация, автор. Части соединяются через "или". */
function searchWhere(search: QueueSearch | undefined): SQL | undefined {
  if (!search) return undefined;
  const parts: SQL[] = [];
  if (search.number !== undefined) parts.push(eq(tickets.number, search.number));
  if (search.text) parts.push(ilike(tickets.title, likeText(search.text)), ilike(tickets.description, likeText(search.text)));
  if (search.orgIds.length > 0) parts.push(inArray(tickets.orgId, search.orgIds));
  if (search.authorIds.length > 0) parts.push(inArray(tickets.authorId, search.authorIds));
  // Строка поиска была, а совпадений ни по чему нет: пусто, а не вся очередь.
  return parts.length > 0 ? (or(...parts) as SQL) : sql`false`;
}

function orderOf(sort: QueueSort) {
  if (sort === 'client_waiting') return [sql`${tickets.clientWaitingSince} asc nulls last`, asc(tickets.ticketId)];
  if (sort === 'updated') return [desc(tickets.modifiedOn), desc(tickets.ticketId)];
  return [sql`${dueOn} asc nulls last`, asc(tickets.ticketId)];
}

export async function queueRowsTx(
  actor: StaffActor,
  input: { queue: QueueKey; sort: QueueSort; search?: QueueSearch; offset: number; limit: number },
): Promise<QueueRecord[]> {
  return withActor(actor, (tx) =>
    tx
      .select({
        ticketId: tickets.ticketId,
        number: tickets.number,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        orgId: tickets.orgId,
        assigneeId: tickets.assigneeId,
        queue: tickets.queue,
        createdOn: tickets.createdOn,
        firstRespondedOn: tickets.firstRespondedOn,
        dueOn,
        snoozedUntil: tickets.snoozedUntil,
        clientWaitingSince: tickets.clientWaitingSince,
      })
      .from(tickets)
      .where(and(queueWhere(input.queue, actor.userId), searchWhere(input.search)))
      .orderBy(...orderOf(input.sort))
      .limit(input.limit)
      .offset(input.offset),
  );
}

/** Счётчики очередей одним запросом. */
export async function queueCountsTx(actor: StaffActor): Promise<Record<QueueKey, number>> {
  const [row] = await withActor(actor, (tx) =>
    tx
      .select(
        Object.fromEntries(
          QUEUE_KEYS.map((key) => [key, sql<number>`count(*) filter (where ${queueWhere(key, actor.userId) ?? sql`true`})::int`]),
        ) as Record<QueueKey, SQL<number>>,
      )
      .from(tickets),
  );
  return row as Record<QueueKey, number>;
}

// --- Сохранённые фильтры (FR-AG-14, UX-A-09) ---

export type SavedFilter = { filterId: string; name: string; query: SavedQuery; isShared: boolean; isMine: boolean };

export async function listFiltersTx(actor: StaffActor): Promise<SavedFilter[]> {
  const rows = await withActor(actor, (tx) =>
    tx.select().from(savedFilters).orderBy(asc(savedFilters.name), asc(savedFilters.filterId)),
  );
  return rows.map((row) => ({ filterId: row.filterId, name: row.name, query: row.query, isShared: row.isShared, isMine: row.ownerId === actor.userId }));
}

export async function saveFilterTx(actor: StaffActor, input: { name: string; query: SavedQuery; isShared: boolean }): Promise<string> {
  const [row] = await withActor(actor, (tx) =>
    tx.insert(savedFilters).values({ ownerId: actor.userId, ...input }).returning({ filterId: savedFilters.filterId }),
  );
  if (!row) throw new Error('hdt: фильтр не сохранён');
  return row.filterId;
}

/** Удаляет только свой фильтр: чужой и несуществующий неразличимы (not_found). */
export async function deleteFilterTx(actor: StaffActor, filterId: string): Promise<void> {
  const deleted = await withActor(actor, (tx) =>
    tx.delete(savedFilters).where(and(eq(savedFilters.filterId, filterId), eq(savedFilters.ownerId, actor.userId))).returning({ filterId: savedFilters.filterId }),
  );
  if (deleted.length === 0) throw new HdtError('not_found');
}

// --- Благодарности, не открывшие обращение (FR-TK-14, план M3, задача 13) ---

export const THANKS_PAGE_SIZE = 50;

/** Сообщения клиентов-благодарностей, новые первыми, на одну строку больше страницы. */
export async function thanksRowsTx(actor: StaffActor, page: number): Promise<{ number: number; orgId: string; body: string; createdOn: Date }[]> {
  return withActor(actor, (tx) =>
    tx
      .select({ number: tickets.number, orgId: tickets.orgId, body: ticketMessages.body, createdOn: ticketMessages.createdOn })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.ticketId, ticketMessages.ticketId))
      .where(eq(ticketMessages.isThanks, true))
      .orderBy(desc(ticketMessages.createdOn))
      .limit(THANKS_PAGE_SIZE + 1)
      .offset((page - 1) * THANKS_PAGE_SIZE),
  );
}
