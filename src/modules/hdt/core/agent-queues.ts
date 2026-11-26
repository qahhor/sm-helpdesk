import 'server-only';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { containsText } from '@/db/contains';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { HdtError } from '../error';
import { type AiHandoffReason, AI_SILENCE_SEC, type Priority, type Queue, type TicketStatus } from '../pref';
import { savedFilters, type SavedQuery, ticketMessages, tickets } from '../schema';
import { SERVICE_ORG_ID } from '@/modules/hdu/api/guests';
import type { Tag } from '@/modules/hdr/api';
import type { QueueKey, QueueSort } from './agent-queue-keys';
import { ticketTagsTx } from './tags';

// Модуль hdt, слой core: очереди рабочего места (FR-AG-01, FR-AG-10, FR-AG-14, FR-AG-18; план M3, задача 5).
// Читает сотрудник под своим актором: политики RLS отдают ему все обращения, а условия очереди задаёт код.

export { QUEUE_KEYS, QUEUE_SORTS, type QueueKey, type QueueSort } from './agent-queue-keys';

/**
 * textIds: обращения, найденные по тексту в Typesense (план W6, решение 4). Есть: условие ticket_id = any(ids) вместо
 * двух containsText по теме и описанию. Нет (Typesense выключен или не ответил): прежний containsText.
 */
export type QueueSearch = { number?: number; text?: string; textIds?: string[]; orgIds: string[]; authorIds: string[] };

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
  snoozeReturnedOn: Date | null;
  /** Время изменения с точностью базы (микросекунды): ключ листания по последнему изменению. */
  modifiedKey: string;
  clientWaitingSince: Date | null;
  /** Причина передачи помощником (очередь "После AI", FR-AG-19). */
  aiHandoffReason: AiHandoffReason | null;
  /** Теги обращения (FR-AUTO-13): читаются той же транзакцией, только если список их просил. */
  tags: Tag[];
};

const OPEN = notInArray(tickets.status, ['resolved', 'closed']);
/** Ближайший срок: первого ответа, пока его не было, иначе решения. */
const dueOn = sql<Date | null>`case when ${tickets.firstRespondedOn} is null then ${tickets.firstResponseDueOn} else ${tickets.resolutionDueOn} end`.mapWith(
  tickets.firstResponseDueOn,
);
/** Помощник не отвечает или молчит дольше 90 секунд (решение 5, слой в): условие считается при показе. */
const AI_NOT_ANSWERING = sql`(${tickets.aiState} <> 'active' or ${tickets.createdOn} < now() - make_interval(secs => ${AI_SILENCE_SEC}))`;
/** Отложенное до своего времени (решение 13 плана M3). */
const notSnoozed = or(isNull(tickets.snoozedUntil), lt(tickets.snoozedUntil, sql`now()`)) as SQL;

/** Условие очереди: что в неё входит (FR-AG-01). */
function queueWhere(queue: QueueKey, me: string): SQL | undefined {
  switch (queue) {
    // Новые первой линии: переданное на вторую ждёт её в своей очереди (решение 0031, пункт 15). Письма с неизвестных
    // адресов ждут привязки в "Неопознанных" (решение 12 вехи M4) и в "Новые" не попадают.
    // Обращение у помощника первой линии в "Новые" не попадает, пока помощник может ответить: 90 секунд с создания
    // (план M5b, решение 5, слой в). Молчит дольше: стоит в "Новых", даже если фоновый процесс остановлен совсем.
    case 'new':
      return and(eq(tickets.status, 'new'), eq(tickets.queue, 'l1'), ne(tickets.orgId, SERVICE_ORG_ID), notSnoozed, AI_NOT_ANSWERING);
    case 'mine':
      return and(eq(tickets.assigneeId, me), ne(tickets.status, 'closed'));
    // "После AI" (решение 19): передано помощником, сотрудник клиенту ещё не ответил. После передачи срок первого
    // ответа начинается заново и first_responded_on пуст до ответа сотрудника (решение 15).
    case 'after_ai':
      return and(eq(tickets.aiState, 'handed_off'), isNull(tickets.firstRespondedOn), OPEN, notSnoozed);
    // "AI ответил, клиент молчит": помощник ведёт обращение и ждёт реакции клиента на свой ответ.
    case 'ai_waiting':
      return and(eq(tickets.aiState, 'active'), eq(tickets.status, 'waiting_customer'), notSnoozed);
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


/** Поиск (FR-AG-10): номер, текст темы и описания, организация, автор. Части соединяются через "или". */
function searchWhere(search: QueueSearch | undefined): SQL | undefined {
  if (!search) return undefined;
  const parts: SQL[] = [];
  if (search.number !== undefined) parts.push(eq(tickets.number, search.number));
  if (search.textIds) {
    if (search.textIds.length > 0) parts.push(inArray(tickets.ticketId, search.textIds));
  } else if (search.text) parts.push(containsText(tickets.title, search.text), containsText(tickets.description, search.text));
  if (search.orgIds.length > 0) parts.push(inArray(tickets.orgId, search.orgIds));
  if (search.authorIds.length > 0) parts.push(inArray(tickets.authorId, search.authorIds));
  // Строка поиска была, а совпадений ни по чему нет: пусто, а не вся очередь.
  return parts.length > 0 ? (or(...parts) as SQL) : sql`false`;
}

/**
 * Фильтр по тегу (FR-AUTO-13): обращения, на которых стоит тег. Подзапрос идёт по индексу hdt_ticket_tags_i1
 * (tag_id, ticket_id) или по уникальному ключу (ticket_id, tag_id), смотря с какой стороны планировщику дешевле.
 */
function tagWhere(tagId: string | undefined): SQL | undefined {
  return tagId ? sql`exists (select 1 from hdt_ticket_tags tt where tt.ticket_id = ${tickets.ticketId} and tt.tag_id = ${tagId}::uuid)` : undefined;
}

function orderOf(sort: QueueSort) {
  if (sort === 'client_waiting') return [sql`${tickets.clientWaitingSince} asc nulls last`, asc(tickets.ticketId)];
  if (sort === 'updated') return [desc(tickets.modifiedOn), desc(tickets.ticketId)];
  return [sql`${dueOn} asc nulls last`, asc(tickets.ticketId)];
}

/**
 * Продолжение после строки с этим ключом при сортировке по последнему изменению (решение 0040, пункт 5). Сравнение
 * пары значений становится границей индекса (modified_on DESC, ticket_id DESC): строки прошлых страниц не читаются.
 */
function afterKey(after: { modifiedKey: string; ticketId: string } | undefined): SQL | undefined {
  return after ? sql`(${tickets.modifiedOn}, ${tickets.ticketId}) < (${after.modifiedKey}::timestamptz, ${after.ticketId}::uuid)` : undefined;
}

export async function queueRowsTx(
  actor: StaffActor,
  input: { queue: QueueKey; sort: QueueSort; search?: QueueSearch; tagId?: string; withTags?: boolean; offset: number; limit: number; after?: { modifiedKey: string; ticketId: string } },
): Promise<QueueRecord[]> {
  return withActor(actor, async (tx) => {
    const rows = await tx
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
        snoozeReturnedOn: tickets.snoozeReturnedOn,
        modifiedKey: sql<string>`to_char(${tickets.modifiedOn} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        clientWaitingSince: tickets.clientWaitingSince,
        aiHandoffReason: tickets.aiHandoffReason,
      })
      .from(tickets)
      .where(and(queueWhere(input.queue, actor.userId), searchWhere(input.search), tagWhere(input.tagId), afterKey(input.after)))
      .orderBy(...orderOf(input.sort))
      .limit(input.limit)
      // Листание по ключу смещения не несёт: далёкая страница стоит столько же, сколько первая.
      .offset(input.after ? 0 : input.offset);
    // Теги строк той же транзакцией: страница очередей не открывает ради них ещё одну (бюджет транзакций, находка A3).
    const tags = input.withTags ? await ticketTagsTx(tx, rows.map((row) => row.ticketId)) : new Map<string, Tag[]>();
    return rows.map((row) => ({ ...row, tags: tags.get(row.ticketId) ?? [] }));
  });
}

const OPEN_QUEUES = ['new', 'after_ai', 'l2', 'waiting', 'development', 'breached'] as const;

/**
 * Счётчики очередей (аудит 23.11.2026, находка P2). Считаются только открытые обращения (по частичному индексу) и
 * "Мои" (по индексу исполнителя): закрытые, которых в базе большинство, не просматриваются. У очереди "Все"
 * счётчика нет: её число равно размеру базы и работе сотрудника не помогает.
 */
export async function queueCountsTx(actor: StaffActor): Promise<Record<QueueKey, number | null>> {
  return withActor(actor, (tx) => queueCountsIn(tx, actor));
}

async function queueCountsIn(tx: Tx, actor: StaffActor): Promise<Record<QueueKey, number | null>> {
  {
    const [open] = await tx
      .select(
        Object.fromEntries(OPEN_QUEUES.map((key) => [key, sql<number>`count(*) filter (where ${queueWhere(key, actor.userId)})::int`])) as Record<
          (typeof OPEN_QUEUES)[number],
          SQL<number>
        >,
      )
      .from(tickets)
      // Условие записано текстом и совпадает с условием индексов hdt_tickets_i12 и i13.
      .where(sql`${tickets.status} not in ('resolved', 'closed')`);
    const [mine] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(queueWhere('mine', actor.userId));
    // "AI ответил, клиент молчит" без счётчика (решение 19): это не работа сотрудника.
    return { new: open?.new ?? 0, after_ai: open?.after_ai ?? 0, ai_waiting: null, l2: open?.l2 ?? 0, waiting: open?.waiting ?? 0, development: open?.development ?? 0, breached: open?.breached ?? 0, mine: mine?.n ?? 0, all: null };
  }
}

/**
 * Боковая панель страницы очередей одной транзакцией: счётчики, сохранённые фильтры и число "Неопознанных"
 * (аудит 23.11.2026, находка A3). Раньше это были три транзакции и три соединения пула на каждый просмотр.
 */
export async function queueSidebarTx(actor: StaffActor): Promise<{ counts: Record<QueueKey, number | null>; filters: SavedFilter[]; unidentified: number }> {
  return withActor(actor, async (tx) => {
    const counts = await queueCountsIn(tx, actor);
    const filters = await listFiltersIn(tx, actor);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(and(eq(tickets.orgId, SERVICE_ORG_ID), ne(tickets.status, 'closed')));
    return { counts, filters, unidentified: row?.n ?? 0 };
  });
}

// --- Сохранённые фильтры (FR-AG-14, UX-A-09) ---

export type SavedFilter = { filterId: string; name: string; query: SavedQuery; isShared: boolean; isMine: boolean };

export async function listFiltersTx(actor: StaffActor): Promise<SavedFilter[]> {
  return withActor(actor, (tx) => listFiltersIn(tx, actor));
}

async function listFiltersIn(tx: Tx, actor: StaffActor): Promise<SavedFilter[]> {
  const rows = await tx.select().from(savedFilters).orderBy(asc(savedFilters.name), asc(savedFilters.filterId));
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
      // Благодарность, которую модель не подтвердила и обращение открыто заново (план M5b, задача 9), в списке нет.
      .where(
        and(
          eq(ticketMessages.isThanks, true),
          sql`not exists (select 1 from hdt_ticket_events e where e.ticket_id = ${ticketMessages.ticketId} and e.kind = 'status' and e.payload ->> 'reason' = 'ai_thanks' and e.payload ->> 'messageId' = ${ticketMessages.messageId}::text)`,
        ),
      )
      .orderBy(desc(ticketMessages.createdOn))
      .limit(THANKS_PAGE_SIZE + 1)
      .offset((page - 1) * THANKS_PAGE_SIZE),
  );
}
