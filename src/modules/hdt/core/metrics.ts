import 'server-only';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { type AuditEntry, writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import type { AdditiveCounters, Counters, LineEvent } from '../metrics-util';
import { ticketEvents, tickets } from '../schema';

// Модуль hdt, слой core: запросы показателей (FR-MET-01, 03, 04, 07, 10, FR-LINE-08; план M8, задача 9, решение 15;
// каналы FR-MET-10: план M6, задача 8).
//
// Определение, общее для всех блоков: "обращения периода" это обращения, СОЗДАННЫЕ в периоде. Каждый блок считается
// одним запросом по индексу даты создания (hdt_tickets_i25), без таблиц накопления и без кеша. Обращение, созданное
// раньше периода и решённое в нём, в показатели периода не входит: оно учтено в периоде своего создания.
// Исключение одно: счётчик "завершено за период" (finishedTx) считает обращения, решённые или закрытые в периоде,
// когда бы они ни были созданы: FR-MET-01 просит новые и закрытые обращения.
//
// Соблюдение SLA: доля обращений периода без отметки нарушения (колонки *_breached_on, их ставит задача раз в минуту)
// среди тех, у кого исход по сроку уже известен. Первый ответ: ответ дан, либо отметка стоит, либо срок прошёл.
// Решение: обращение решено, либо отметка стоит, либо срок прошёл и не стоит на паузе. Объединённые дубли в расчёт
// сроков и в "решено" не входят: их закрывает объединение, а не работа над ними.

export type Range = { from: Date; to: Date };

const inPeriod = (range: Range): SQL => and(gte(tickets.createdOn, range.from), lt(tickets.createdOn, range.to)) as SQL;

/** Обращение решено: статус "Решено" или "Закрыто" с датой решения, не дубль. Открытое заново сюда не входит. */
const RESOLVED = sql`(${tickets.status} in ('resolved', 'closed') and ${tickets.resolvedOn} is not null and ${tickets.mergedIntoId} is null)`;

const firstResponseDecided = (now: Date) =>
  sql`(${tickets.mergedIntoId} is null and (${tickets.firstRespondedOn} is not null or ${tickets.firstResponseBreachedOn} is not null or ${tickets.firstResponseDueOn} < ${now.toISOString()}::timestamptz))`;
const resolutionDecided = (now: Date) =>
  sql`(${tickets.mergedIntoId} is null and (${RESOLVED} or ${tickets.resolutionBreachedOn} is not null or (${tickets.resolutionDueOn} < ${now.toISOString()}::timestamptz and ${tickets.slaPausedOn} is null)))`;

const count = (where?: SQL) => (where ? sql<number>`(count(*) filter (where ${where}))::int` : sql<number>`count(*)::int`);

/** Счётчики, общие для сводки и срезов. */
const counters = (now: Date) => ({
  created: count(),
  resolved: count(RESOLVED),
  closed: count(sql`${tickets.status} = 'closed' and ${tickets.mergedIntoId} is null`),
  firstResponseTotal: count(firstResponseDecided(now)),
  firstResponseOk: count(sql`${firstResponseDecided(now)} and ${tickets.firstResponseBreachedOn} is null`),
  resolutionTotal: count(resolutionDecided(now)),
  resolutionOk: count(sql`${resolutionDecided(now)} and ${tickets.resolutionBreachedOn} is null`),
  rated: sql<number>`count(${tickets.csatScore})::int`,
  csatAverage: sql<number | null>`avg(${tickets.csatScore})::float8`,
  csatHigh: count(sql`${tickets.csatScore} >= 4`),
});

export type { Counters };

/**
 * Счётчики обращений периода по источникам одним просмотром (FR-MET-01, 03, 10): из этих строк складываются сводка,
 * источники и каналы (combineCounters). Прежде это были три просмотра одних и тех же строк периода: на 130 тысячах
 * обращений за 90 дней каждый стоил 130-200 мс (замер подготовки M9, задача 4).
 */
export function sourceCountersTx(tx: Tx, range: Range, now: Date): Promise<(AdditiveCounters & { source: string })[]> {
  const all = counters(now);
  const additive = { created: all.created, resolved: all.resolved, closed: all.closed, firstResponseTotal: all.firstResponseTotal, firstResponseOk: all.firstResponseOk, resolutionTotal: all.resolutionTotal, resolutionOk: all.resolutionOk, rated: all.rated, csatHigh: all.csatHigh };
  return tx
    .select({ source: tickets.source, ...additive, csatSum: sql<number>`coalesce(sum(${tickets.csatScore}), 0)::int` })
    .from(tickets)
    .where(inPeriod(range))
    .groupBy(tickets.source);
}

/**
 * Момент завершения обращения: дата решения, а у закрытого без решения (автозакрытие из ожидания, закрытие клиентом)
 * дата закрытия. Выражение совпадает с индексом hdt_tickets_i26 (миграция 0066) и записано через CASE: условие по
 * COALESCE планировщик не берёт в индекс раньше политик RLS.
 */
const FINISHED_ON = sql`(case when ${tickets.resolvedOn} is not null then ${tickets.resolvedOn} else ${tickets.closedOn} end)`;

/**
 * Завершено за период (FR-MET-01): обращения, решённые или закрытые в периоде, когда бы они ни были созданы. Считается
 * по текущему состоянию: открытое заново не завершено, объединённый дубль закрыт объединением и не считается.
 * Отдельный запрос по частичному индексу hdt_tickets_i26.
 */
export async function finishedTx(tx: Tx, range: Range): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(tickets)
    .where(and(sql`${FINISHED_ON} >= ${range.from.toISOString()}::timestamptz`, sql`${FINISHED_ON} < ${range.to.toISOString()}::timestamptz`, inArray(tickets.status, ['resolved', 'closed']), isNull(tickets.mergedIntoId)));
  return row?.n ?? 0;
}

export type RespondedRow = { createdOn: Date; firstRespondedOn: Date; priority: string };

/** Обращения периода с первым ответом: по ним считается время первого ответа. Не больше limit строк, старые первыми. */
export async function respondedRowsTx(tx: Tx, range: Range, limit: number): Promise<RespondedRow[]> {
  const rows = await tx
    .select({ createdOn: tickets.createdOn, firstRespondedOn: tickets.firstRespondedOn, priority: tickets.priority })
    .from(tickets)
    .where(and(inPeriod(range), isNotNull(tickets.firstRespondedOn), isNull(tickets.mergedIntoId)))
    .orderBy(asc(tickets.createdOn))
    .limit(limit);
  return rows.flatMap((row) => (row.firstRespondedOn ? [{ ...row, firstRespondedOn: row.firstRespondedOn }] : []));
}

export type ResolvedRow = { ticketId: string; createdOn: Date; resolvedOn: Date; priority: string; queue: string; pausedMinutes: number };

/** Решённые обращения периода: время решения и линии. Не больше limit строк, старые первыми. */
export async function resolvedRowsTx(tx: Tx, range: Range, limit: number): Promise<ResolvedRow[]> {
  const rows = await tx
    .select({
      ticketId: tickets.ticketId,
      createdOn: tickets.createdOn,
      resolvedOn: tickets.resolvedOn,
      priority: tickets.priority,
      queue: tickets.queue,
      pausedMinutes: tickets.slaPausedMinutes,
    })
    .from(tickets)
    .where(and(inPeriod(range), RESOLVED))
    .orderBy(asc(tickets.createdOn))
    .limit(limit);
  return rows.flatMap((row) => (row.resolvedOn ? [{ ...row, resolvedOn: row.resolvedOn }] : []));
}

/** Сколько обращений запрашивается за раз по списку идентификаторов. */
const ID_BATCH = 1000;

/**
 * События смены очереди и статуса по обращениям: из них восстанавливается путь по линиям. Прежнюю очередь сотрудник
 * пишет в поле from, правило автоматизации в поле was (core/automation.ts): читаются оба.
 */
export async function lineEventsTx(tx: Tx, ticketIds: readonly string[]): Promise<Map<string, LineEvent[]>> {
  const byTicket = new Map<string, LineEvent[]>();
  for (let start = 0; start < ticketIds.length; start += ID_BATCH) {
    const rows = await tx
      .select({
        ticketId: ticketEvents.ticketId,
        kind: ticketEvents.kind,
        from: sql<string | null>`coalesce(${ticketEvents.payload}->>'from', ${ticketEvents.payload}->>'was')`,
        // Передача помощником (план M5b, задача 10): помощник перестаёт вести обращение.
        to: sql<string | null>`case when ${ticketEvents.kind} = 'ai_handoff' then 'handed_off' else ${ticketEvents.payload}->>'to' end`,
        at: ticketEvents.createdOn,
      })
      .from(ticketEvents)
      .where(and(inArray(ticketEvents.ticketId, ticketIds.slice(start, start + ID_BATCH)), inArray(ticketEvents.kind, ['queue', 'status', 'ai_state', 'ai_handoff'])))
      .orderBy(asc(ticketEvents.createdOn), asc(ticketEvents.eventId));
    for (const row of rows) {
      const list = byTicket.get(row.ticketId) ?? [];
      list.push({ kind: row.kind === 'ai_state' || row.kind === 'ai_handoff' ? 'ai' : (row.kind as 'queue' | 'status'), from: row.from, to: row.to, at: row.at });
      byTicket.set(row.ticketId, list);
    }
  }
  return byTicket;
}

export type BreakdownRow = Counters & { key: string | null };

/** Срез периода по организациям или модулям (FR-MET-04): больше обращений выше, при равенстве по ключу. */
export function breakdownTx(tx: Tx, range: Range, by: 'org' | 'module', now: Date, page: { limit: number; offset: number }): Promise<BreakdownRow[]> {
  const column = by === 'org' ? tickets.orgId : tickets.moduleId;
  return tx
    .select({ key: sql<string | null>`${column}`, ...counters(now) })
    .from(tickets)
    .where(inPeriod(range))
    .groupBy(column)
    .orderBy(sql`count(*) desc`, sql`${column} asc nulls last`)
    .limit(page.limit)
    .offset(page.offset);
}

export type LowRatingRow = {
  number: number;
  orgId: string;
  assigneeId: string | null;
  score: number;
  reason: string | null;
  comment: string | null;
  createdOn: Date;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedOn: Date | null;
};

/** Обращения периода с оценкой от 1 до 3 (FR-MET-07), новые первыми. */
export async function lowRatingsTx(tx: Tx, range: Range, limit: number): Promise<LowRatingRow[]> {
  const rows = await tx
    .select({
      number: tickets.number,
      orgId: tickets.orgId,
      assigneeId: tickets.assigneeId,
      score: tickets.csatScore,
      reason: tickets.csatReason,
      comment: tickets.csatComment,
      createdOn: tickets.createdOn,
      reviewNote: tickets.csatReviewNote,
      reviewedBy: tickets.csatReviewedBy,
      reviewedOn: tickets.csatReviewedOn,
    })
    .from(tickets)
    .where(and(inPeriod(range), lte(tickets.csatScore, 3)))
    .orderBy(desc(tickets.createdOn), desc(tickets.ticketId))
    .limit(limit);
  return rows.map((row) => ({ ...row, score: row.score ?? 0 }));
}

export type RequestRow = {
  number: number;
  createdOn: Date;
  orgId: string;
  moduleId: string | null;
  type: string;
  priority: string;
  source: string;
  status: string;
  firstRespondedOn: Date | null;
  resolvedOn: Date | null;
  pausedMinutes: number;
  merged: boolean;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  score: number | null;
};

/** Обращения периода для выгрузки: по строке на обращение, без темы, описания и переписки (решение 16). */
export function requestRowsTx(tx: Tx, range: Range, limit: number): Promise<RequestRow[]> {
  return tx
    .select({
      number: tickets.number,
      createdOn: tickets.createdOn,
      orgId: tickets.orgId,
      moduleId: tickets.moduleId,
      type: sql<string>`${tickets.type}`,
      priority: sql<string>`${tickets.priority}`,
      source: sql<string>`${tickets.source}`,
      status: sql<string>`${tickets.status}`,
      firstRespondedOn: tickets.firstRespondedOn,
      resolvedOn: tickets.resolvedOn,
      pausedMinutes: tickets.slaPausedMinutes,
      merged: sql<boolean>`${tickets.mergedIntoId} is not null`,
      firstResponseBreached: sql<boolean>`${tickets.firstResponseBreachedOn} is not null`,
      resolutionBreached: sql<boolean>`${tickets.resolutionBreachedOn} is not null`,
      score: tickets.csatScore,
    })
    .from(tickets)
    .where(inPeriod(range))
    .orderBy(asc(tickets.createdOn), asc(tickets.ticketId))
    .limit(limit);
}

/**
 * Заметка руководителя о разборе низкой оценки (FR-MET-07). Одной транзакцией: колонки обращения, внутреннее событие
 * истории и запись журнала. В журнал текст заметки не идёт. Роль и оценку проверяет ещё и триггер базы (миграция 0064).
 */
export async function saveCsatReviewTx(actor: StaffActor, number: number, note: string): Promise<void> {
  await withActor(actor, async (tx) => {
    const [ticket] = await tx
      .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, score: tickets.csatScore, hadNote: sql<boolean>`${tickets.csatReviewNote} is not null` })
      .from(tickets)
      .where(eq(tickets.number, number))
      .limit(1)
      .for('update');
    if (!ticket) throw new HdtError('not_found');
    if (ticket.score === null || ticket.score > 3) throw new HdtError('invalid_input');
    await tx.update(tickets).set({ csatReviewNote: note, csatReviewedBy: actor.userId, csatReviewedOn: sql`now()` }).where(eq(tickets.ticketId, ticket.ticketId));
    await tx.insert(ticketEvents).values({
      orgId: ticket.orgId,
      ticketId: ticket.ticketId,
      kind: 'csat_review',
      actorType: 'staff',
      actorId: actor.userId,
      payload: { score: ticket.score, note },
      isInternal: true,
    });
    await writeAudit(tx, { action: 'ticket.csat_reviewed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: { score: ticket.score, updated: ticket.hadNote } });
  });
}

/** Запись журнала от имени сотрудника отдельной транзакцией: выгрузка данных не меняет, но должна быть записана. */
export async function auditAsStaff(actor: StaffActor, entry: AuditEntry): Promise<void> {
  await withActor(actor, (tx) => writeAudit(tx, entry));
}

// --- Показатели AI-помощника (план M5b, задача 10; FR-MET-06, FR-AI-18) ---

export type AssistantTicketStats = {
  handled: number;
  resolvedByAi: number;
  handoffs: { reason: string; count: number }[];
  /** Секунды от создания до первого сообщения помощника, по обращениям помощника периода. */
  firstReplySeconds: number[];
  csatCount: number;
  csatSum: number;
  reopenedAfterHelped: number;
};

/**
 * Обращения периода (по дате создания, индекс hdt_tickets_i25), которые вёл помощник: решено помощником, передачи по
 * причинам, время первого ответа помощника (сообщения по индексу hdt_ticket_messages_i1), оценки решённых помощником,
 * открытые заново после "Помогло" (событие ai_feedback "helped", после него переход из "Решено" в работу).
 */
export async function assistantStatsTx(tx: Tx, range: Range): Promise<AssistantTicketStats> {
  const scope = and(inPeriod(range), sql`${tickets.aiState} <> 'none'`, isNull(tickets.mergedIntoId));
  const [totals] = await tx
    .select({
      handled: sql<number>`count(*)::int`,
      resolvedByAi: sql<number>`count(*) filter (where ${tickets.aiState} = 'resolved_by_ai')::int`,
      csatCount: sql<number>`count(${tickets.csatScore}) filter (where ${tickets.aiState} = 'resolved_by_ai')::int`,
      csatSum: sql<number>`coalesce(sum(${tickets.csatScore}) filter (where ${tickets.aiState} = 'resolved_by_ai'), 0)::int`,
      reopened: sql<number>`count(*) filter (where exists (
        select 1 from hdt_ticket_events h join hdt_ticket_events r on r.ticket_id = h.ticket_id and r.created_on > h.created_on
         where h.ticket_id = hdt_tickets.ticket_id and h.kind = 'ai_feedback' and h.payload ->> 'choice' = 'helped'
           and r.kind = 'status' and r.payload ->> 'from' = 'resolved' and r.payload ->> 'to' <> 'closed'))::int`,
    })
    .from(tickets)
    .where(scope);
  const handoffs = await tx
    .select({ reason: sql<string>`${tickets.aiHandoffReason}`, count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(scope, isNotNull(tickets.aiHandoffReason)))
    .groupBy(tickets.aiHandoffReason)
    .orderBy(tickets.aiHandoffReason);
  const firsts = await tx
    .select({
      seconds: sql<number>`extract(epoch from (select min(m.created_on) from hdt_ticket_messages m where m.ticket_id = hdt_tickets.ticket_id and m.author_type = 'ai') - hdt_tickets.created_on)::float`,
    })
    .from(tickets)
    .where(scope);
  return {
    handled: totals?.handled ?? 0,
    resolvedByAi: totals?.resolvedByAi ?? 0,
    handoffs,
    firstReplySeconds: firsts.flatMap((r) => (r.seconds === null ? [] : [Number(r.seconds)])),
    csatCount: totals?.csatCount ?? 0,
    csatSum: totals?.csatSum ?? 0,
    reopenedAfterHelped: totals?.reopened ?? 0,
  };
}
