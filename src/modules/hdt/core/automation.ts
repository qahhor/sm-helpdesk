import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { emitEventTx, writeAudit } from '@/modules/hdc/api';
import type { DomainEventKind } from '@/modules/hdc/pref';
import { readSlaConfig, tagsByIdTx } from '@/modules/hdr/api';
import { lineLeads } from '@/modules/hdu/api/recipients';
import { canTransition, type Impact, type Priority, type Queue, type TicketSource, type TicketStatus, type TicketType, TRANSFERABLE_STATUSES } from '../pref';
import { ticketEvents, ticketMessages, tickets, ticketTags } from '../schema';
import { isHdtError } from '../error';
import { type LockedTicket } from './agent-actions';
import { canAddTagTx } from './tags';
import { notifyTicketTx, oncallP1Tx } from './notify';
import { calendarFor, refreshSla, soonMoment } from './sla';

// Модуль hdt, слой core: действия правил автоматизации над обращением (FR-AUTO-04, 07, 09, 11; план M8, задача 3).
// Вызывает их только модуль правил из транзакции системного актора: lockRuleTicketTx это проверяет. Каждое действие
// делает то же, что действие сотрудника: те же проверки, событие истории и запись журнала аудита, только автор
// система. События истории помечены byRule: рабочее место показывает вместо них одну запись "Правило ...". События
// предметной области пишутся с отметкой "порождено правилом": правила на них не срабатывают (FR-AUTO-07).
//
// Действие не бросает ошибку на ожидаемом отказе (переход запрещён, тега нет): возвращает код, который правило
// записывает в журнал срабатываний, и остальные действия продолжаются.

/** Итог действия правила. unchanged: менять было нечего, действие считается выполненным. */
export type RuleActionResult = { ok: true; from?: string | null; to?: string | null; unchanged?: true } | { ok: false; detail: string };

const SETTLED: readonly TicketStatus[] = ['resolved', 'closed'];
const done = (from?: string | null, to?: string | null): RuleActionResult => ({ ok: true, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const unchanged = (value?: string | null): RuleActionResult => ({ ok: true, unchanged: true, ...(value !== undefined ? { from: value, to: value } : {}) });
const refused = (detail: string): RuleActionResult => ({ ok: false, detail });

/**
 * Обращение события с блокировкой строки. Только в транзакции системы. Нет обращения: null. skipLocked: строку
 * держит другая транзакция (сотрудник или второй процесс), обращение пропускается до следующего запуска.
 */
export async function lockRuleTicketTx(tx: Tx, ticketId: string, opts: { skipLocked?: boolean } = {}): Promise<LockedTicket | null> {
  const actor = await tx.execute<{ type: string }>(sql`select app.actor_type() as type`);
  if (actor.rows[0]?.type !== 'system') throw new Error('hdt: действия правил выполняет только система');
  const [row] = await tx
    .select({
      ticketId: tickets.ticketId,
      orgId: tickets.orgId,
      number: tickets.number,
      status: tickets.status,
      priority: tickets.priority,
      type: tickets.type,
      moduleId: tickets.moduleId,
      assigneeId: tickets.assigneeId,
      queue: tickets.queue,
      snoozedUntil: tickets.snoozedUntil,
      snoozeReturnedOn: tickets.snoozeReturnedOn,
      mergedIntoId: tickets.mergedIntoId,
    })
    .from(tickets)
    .where(eq(tickets.ticketId, ticketId))
    .limit(1)
    .for('update', opts.skipLocked ? { skipLocked: true } : undefined);
  return row ?? null;
}

/** Событие истории от системы и запись журнала в транзакции правила. Клиенту видно только событие статуса. */
async function record(tx: Tx, ticket: LockedTicket, change: { kind: 'status' | 'priority' | 'assignee' | 'queue' | 'snooze' | 'tag'; payload: Record<string, unknown>; audit: Parameters<typeof writeAudit>[1]['action'] }): Promise<void> {
  const payload = { ...change.payload, byRule: true };
  await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: change.kind, actorType: 'system', payload, isInternal: change.kind !== 'status' });
  await writeAudit(tx, { action: change.audit, objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: payload });
}

async function unassign(tx: Tx, ticket: LockedTicket): Promise<void> {
  if (!ticket.assigneeId) return;
  await record(tx, ticket, { kind: 'assignee', payload: { from: ticket.assigneeId, to: null, toName: null }, audit: 'ticket.assigned' });
  ticket.assigneeId = null;
}

/**
 * Сменить очередь (линию). Как у сотрудника: решённое и закрытое не передаётся; с первой линии только из открытого
 * статуса; "В разработке" на первую линию не возвращается (разработка это вторая линия). Исполнитель снимается:
 * обращение ждёт в новой очереди. Строки передачи с записью сотрудника и сроком "взять в работу" правило не пишет:
 * у передачи правилом нет автора, а таблицу передач пишет только сотрудник (миграции 0025 и 0030).
 */
export async function ruleSetQueueTx(tx: Tx, ticket: LockedTicket, queue: Queue): Promise<RuleActionResult> {
  const from = ticket.queue as Queue;
  if (from === queue) return unchanged(queue);
  if (ticket.mergedIntoId) return refused('merged');
  if (SETTLED.includes(ticket.status)) return refused('transition_refused');
  if (from === 'l1' && !TRANSFERABLE_STATUSES.includes(ticket.status)) return refused('transition_refused');
  if (queue === 'l1' && ticket.status === 'in_development') return refused('transition_refused');
  await unassign(tx, ticket);
  await tx.update(tickets).set({ queue, assigneeId: null }).where(eq(tickets.ticketId, ticket.ticketId));
  await record(tx, ticket, { kind: 'queue', payload: { was: from, to: queue }, audit: queue === 'l1' ? 'ticket.line_returned' : 'ticket.line_transferred' });
  ticket.queue = queue;
  return done(from, queue);
}

/** Назначить исполнителя. Существование и роль сотрудника проверяет модуль правил по справочнику сотрудников. */
export async function ruleAssignTx(tx: Tx, ticket: LockedTicket, assignee: { id: string; name: string }): Promise<RuleActionResult> {
  if (ticket.assigneeId === assignee.id) return unchanged(assignee.name);
  if (ticket.mergedIntoId) return refused('merged');
  const from = ticket.assigneeId;
  await tx.update(tickets).set({ assigneeId: assignee.id }).where(eq(tickets.ticketId, ticket.ticketId));
  await record(tx, ticket, { kind: 'assignee', payload: { from, to: assignee.id, toName: assignee.name }, audit: 'ticket.assigned' });
  ticket.assigneeId = assignee.id;
  return done(from, assignee.name);
}

/**
 * Следующий по кругу среди кандидатов (FR-AUTO-04): у кого меньше открытых назначенных обращений (не "Решено" и не
 * "Закрыто"); при равенстве тот, кому обращение назначали раньше всех (кому не назначали никогда, первый); затем по
 * идентификатору. Выбор идёт под блокировкой транзакции: два события одновременно не выберут одного и того же по
 * устаревшим числам. Кандидатов нет: null.
 */
export async function rulePickRoundRobinTx(tx: Tx, candidates: readonly string[]): Promise<string | null> {
  const ids = [...new Set(candidates)];
  if (ids.length === 0) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.round_robin'))`);
  const list = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
  const result = await tx.execute<{ user_id: string }>(sql`
    select c.user_id
      from unnest(${list}) as c(user_id)
      left join lateral (select count(*) as open from hdt_tickets t where t.assignee_id = c.user_id and t.status not in ('resolved', 'closed')) load on true
      left join lateral (select e.created_on from hdt_ticket_events e
                          where e.kind = 'assignee' and e.payload ->> 'to' = c.user_id::text
                          order by e.created_on desc limit 1) last on true
     order by load.open, last.created_on nulls first, c.user_id
     limit 1`);
  return result.rows[0]?.user_id ?? null;
}

/**
 * Сменить приоритет: сроки пересчитаны от создания (FR-SLA-03). Отметку "приоритет подтверждён сотрудником" правило
 * не ставит: это решение человека. Сообщение дежурным о P1 (FR-SLA-07) ставит предустановленное правило по событию
 * priority_changed: его уведомление срабатывает и на событие, порождённое правилом (план M8, задача 10).
 */
export async function ruleSetPriorityTx(tx: Tx, ticket: LockedTicket, priority: Priority): Promise<RuleActionResult> {
  const from = ticket.priority;
  if (from === priority) return unchanged(priority);
  await record(tx, ticket, { kind: 'priority', payload: { from, to: priority }, audit: 'ticket.priority_changed' });
  await refreshSla(tx, ticket.ticketId, new Date(), { priority });
  await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'priority_changed', payload: { from, to: priority }, byRule: true });
  ticket.priority = priority;
  return done(from, priority);
}

/** Поставить тег из справочника. Тега нет (удалён администратором): отказ. Уже стоит: менять нечего. */
export async function ruleAddTagTx(tx: Tx, ticket: LockedTicket, tagId: string): Promise<RuleActionResult> {
  const tag = (await tagsByIdTx(tx, [tagId])).get(tagId);
  if (!tag) return refused('tag_missing');
  try {
    if (!(await canAddTagTx(tx, ticket.ticketId, tagId))) return unchanged(tag.name);
  } catch (error) {
    // На обращении уже предельное число тегов: отказ действия с кодом, остальные действия правила идут дальше.
    if (isHdtError(error) && error.code === 'too_many_tags') return refused('too_many_tags');
    throw error;
  }
  const added = await tx.insert(ticketTags).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, tagId, addedBy: null }).onConflictDoNothing().returning({ ticketTagId: ticketTags.ticketTagId });
  if (added.length === 0) return unchanged(tag.name);
  await record(tx, ticket, { kind: 'tag', payload: { action: 'added', tagId, name: tag.name }, audit: 'ticket.tag_added' });
  return done(null, tag.name);
}

/** Снять тег. Тега нет в справочнике: отказ. На обращении его нет: менять нечего. */
export async function ruleRemoveTagTx(tx: Tx, ticket: LockedTicket, tagId: string): Promise<RuleActionResult> {
  const tag = (await tagsByIdTx(tx, [tagId])).get(tagId);
  if (!tag) return refused('tag_missing');
  const removed = await tx.delete(ticketTags).where(and(eq(ticketTags.ticketId, ticket.ticketId), eq(ticketTags.tagId, tagId))).returning({ ticketTagId: ticketTags.ticketTagId });
  if (removed.length === 0) return unchanged(null);
  await record(tx, ticket, { kind: 'tag', payload: { action: 'removed', tagId, name: tag.name }, audit: 'ticket.tag_removed' });
  return done(tag.name, null);
}

/** Внутренняя заметка от имени системы: клиент её не видит, сроки она не трогает. */
export async function ruleAddNoteTx(tx: Tx, ticket: LockedTicket, text: string): Promise<RuleActionResult> {
  await tx.insert(ticketMessages).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorType: 'system', body: text, isInternal: true, isAuto: true });
  return done();
}

/**
 * Автоматический ответ клиенту (FR-AUTO-11): публичное сообщение системы с отметкой is_auto, письмо и уведомление
 * клиенту как об ответе сотрудника. Первым ответом сотрудника он не считается: срок первого ответа не
 * останавливается, статус и исполнитель не меняются. В объединённое обращение клиенту не отвечают.
 */
export async function ruleReplyTx(tx: Tx, ticket: LockedTicket, body: string): Promise<RuleActionResult> {
  if (ticket.mergedIntoId) return refused('merged');
  const [message] = await tx
    .insert(ticketMessages)
    .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorType: 'system', body, isInternal: false, isAuto: true })
    .returning({ messageId: ticketMessages.messageId });
  if (!message) throw new Error('hdt: автоматический ответ не сохранён');
  await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'staff_reply', actorUserId: null, messageId: message.messageId });
  await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'staff_replied', payload: { messageId: message.messageId, auto: true }, byRule: true });
  return done();
}

/** Отложить до момента (FR-AG-13): сроки не останавливаются. */
export async function ruleSnoozeTx(tx: Tx, ticket: LockedTicket, until: Date): Promise<RuleActionResult> {
  if (SETTLED.includes(ticket.status)) return refused('transition_refused');
  await tx.update(tickets).set({ snoozedUntil: until, snoozeReturnedOn: null }).where(eq(tickets.ticketId, ticket.ticketId));
  await record(tx, ticket, { kind: 'snooze', payload: { until: until.toISOString() }, audit: 'ticket.snoozed' });
  ticket.snoozedUntil = until;
  ticket.snoozeReturnedOn = null;
  return done(null, until.toISOString());
}

/**
 * Сменить статус только по таблице разрешённых переходов (раздел 7.2): иначе transition_refused. Объединённое
 * обращение закрыто навсегда. Событие статуса видно клиенту, сроки пересчитаны, клиенту уходит то же уведомление,
 * что при смене статуса сотрудником.
 */
export async function ruleSetStatusTx(tx: Tx, ticket: LockedTicket, to: TicketStatus): Promise<RuleActionResult> {
  const from = ticket.status;
  if (from === to) return unchanged(to);
  if (ticket.mergedIntoId) return refused('merged');
  // "Решено" требует итога, его выбирает сотрудник (FR-AG-09): правило этот статус не ставит.
  if (to === 'resolved' || to === 'new' || !canTransition(from, to)) return refused('transition_refused');
  await record(tx, ticket, { kind: 'status', payload: { from, to }, audit: 'ticket.status_changed' });
  await refreshSla(tx, ticket.ticketId, new Date(), { status: to, ...(to === 'closed' ? { closedOn: sql`now()` } : {}) });
  await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from, to }, byRule: true });
  ticket.status = to;
  await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'status', actorUserId: null, to });
  return done(from, to);
}

// --- Уведомления предустановленных правил (FR-AUTO-12; план M8, задача 10) ---
// Прежние встроенные уведомления: те же получатели, шаблоны и однократность, что были у прямых вызовов из действий
// над обращением. Изменился только запуск: их вызывает действие предустановленного правила.

/**
 * Сообщение дежурным о P1 (FR-SLA-07): одно на обращение, пока нет первого ответа. Обращение не P1, первый ответ дан
 * или сообщение уже уходило: менять нечего.
 */
export async function ruleOncallP1Tx(tx: Tx, ticket: LockedTicket): Promise<RuleActionResult> {
  return (await oncallP1Tx(tx, ticket.ticketId)) ? done(null, 'oncall') : unchanged();
}

/**
 * Нарушение срока (FR-SLA-06): руководителям линии обращения уведомление в портале и письмо по их настройке.
 * Линия берётся по очереди обращения, как раньше в задаче раз в минуту. Руководителей нет: отказ no_recipients.
 */
export async function ruleNotifyBreachTx(tx: Tx, ticket: LockedTicket, deadline: 'first_response' | 'resolution'): Promise<RuleActionResult> {
  const leads = await lineLeads(ticket.queue === 'l1' ? 'l1' : 'l2');
  if (leads.length === 0) return refused('no_recipients');
  await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'sla_breach', actorUserId: null, breach: deadline, leads });
  return done();
}

/**
 * Низкая оценка (FR-AUTO-12): сотрудникам из списка уведомление в портале и письмо. Получателей (роль care) выбирает
 * модуль правил по справочнику сотрудников. Оценка читается из обращения: нет оценки или она выше 2, отказ.
 */
export async function ruleNotifyCsatLowTx(tx: Tx, ticket: LockedTicket, recipients: readonly string[]): Promise<RuleActionResult> {
  const [row] = await tx.select({ score: tickets.csatScore }).from(tickets).where(eq(tickets.ticketId, ticket.ticketId)).limit(1);
  const score = row?.score ?? null;
  if (score === null || score > 2) return refused('not_low_rating');
  if (recipients.length === 0) return refused('no_recipients');
  await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'csat_low', actorUserId: null, leads: [...recipients], score });
  return done(null, String(score));
}

/**
 * Запись "сработало правило" в истории обращения (FR-AUTO-09): одна на срабатывание, всегда внутренняя
 * (ограничение hdt_ticket_events_c3 видимой клиенту её не принимает).
 */
export async function ruleHistoryTx(tx: Tx, ticket: { ticketId: string; orgId: string }, payload: Record<string, unknown>): Promise<void> {
  await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'rule', actorType: 'system', payload, isInternal: true });
}

// --- Чтение для условий правил ---

/** Поля обращения для условий правил. Категорию организации, рабочее время и теги по названиям добавляет модуль правил. */
export type RuleTicketFacts = {
  ticketId: string;
  orgId: string;
  number: number;
  type: TicketType;
  moduleId: string | null;
  priority: Priority;
  impact: Impact;
  status: TicketStatus;
  queue: Queue;
  source: TicketSource;
  locale: string;
  title: string;
  description: string;
  createdOn: Date;
  modifiedOn: Date;
  assigneeId: string | null;
  rating: number | null;
  lastClientMessageOn: Date | null;
  lastStaffMessageOn: Date | null;
  tagIds: string[];
};

/** Сколько обращений читается одним запросом. */
const FACTS_CHUNK = 500;

/**
 * Поля обращений для условий правил: обращения, последний публичный ответ сотрудника и теги, по запросу на пачку.
 * withText: false: тема и описание не читаются и возвращаются пустыми строками.
 */
export async function ruleTicketFactsTx(tx: Tx, ticketIds: readonly string[], opts: { withText?: boolean } = {}): Promise<Map<string, RuleTicketFacts>> {
  const withText = opts.withText !== false;
  const facts = new Map<string, RuleTicketFacts>();
  const ids = [...new Set(ticketIds)];
  for (let from = 0; from < ids.length; from += FACTS_CHUNK) {
    const chunk = ids.slice(from, from + FACTS_CHUNK);
    const rows = await tx
      .select({
        ticketId: tickets.ticketId,
        orgId: tickets.orgId,
        number: tickets.number,
        type: tickets.type,
        moduleId: tickets.moduleId,
        priority: tickets.priority,
        impact: tickets.impact,
        status: tickets.status,
        queue: tickets.queue,
        source: tickets.source,
        locale: tickets.locale,
        title: withText ? tickets.title : sql<string>`''`,
        description: withText ? tickets.description : sql<string>`''`,
        createdOn: tickets.createdOn,
        modifiedOn: tickets.modifiedOn,
        assigneeId: tickets.assigneeId,
        rating: tickets.csatScore,
        lastClientMessageOn: tickets.lastClientMessageOn,
      })
      .from(tickets)
      .where(inArray(tickets.ticketId, chunk));
    // Последний публичный ответ сотрудника: по индексу (ticket_id, created_on). Автоматические ответы пишет система, они не в счёт.
    const staff = await tx
      .select({ ticketId: ticketMessages.ticketId, at: sql<Date | string>`max(${ticketMessages.createdOn})` })
      .from(ticketMessages)
      .where(and(inArray(ticketMessages.ticketId, chunk), eq(ticketMessages.authorType, 'staff'), eq(ticketMessages.isInternal, false)))
      .groupBy(ticketMessages.ticketId);
    const staffOn = new Map(staff.map((row) => [row.ticketId, new Date(row.at)]));
    const tagRows = await tx.select({ ticketId: ticketTags.ticketId, tagId: ticketTags.tagId }).from(ticketTags).where(inArray(ticketTags.ticketId, chunk));
    for (const row of rows)
      facts.set(row.ticketId, {
        ...row,
        queue: row.queue as Queue,
        lastStaffMessageOn: staffOn.get(row.ticketId) ?? null,
        tagIds: tagRows.filter((tag) => tag.ticketId === row.ticketId).map((tag) => tag.tagId),
      });
  }
  return facts;
}

// --- Событие "нет активности" ---

/** Молчание обращения: отметка (идентификатор последнего сообщения человека или "created") и когда оно началось. */
export type Silence = { ticketId: string; marker: string; since: Date };

/**
 * Последнее сообщение человека в обращении: публичное сообщение клиента или сотрудника. Внутренние заметки,
 * сообщения системы и автоматические ответы правил молчание не прерывают: иначе правило само взводило бы себя заново.
 */
const lastHumanMessage = sql`
  left join lateral (
    select m.message_id, m.created_on from hdt_ticket_messages m
     where m.ticket_id = t.ticket_id and not m.is_internal and not m.is_auto and m.author_type in ('client', 'staff')
     order by m.created_on desc, m.message_id desc limit 1) last on true`;

/**
 * Обращения, которые молчат с момента не позже cutoff: пачка по порядку идентификаторов после after. Отбор по
 * статусам идёт в базе; условия правила проверяет модуль правил на снимках. Сообщений не было: молчание идёт от
 * создания обращения, отметка "created". notBefore: молчание началось не раньше этого момента (граница включения
 * правила).
 */
export async function silentTicketsTx(
  tx: Tx,
  opts: { cutoff: Date; notBefore?: Date | null; statuses: readonly TicketStatus[]; after: string | null; limit: number; /** Пробный прогон: последние по номеру, без продолжения. */ newest?: boolean },
): Promise<Silence[]> {
  if (opts.statuses.length === 0) return [];
  const statuses = sql.join(opts.statuses.map((status) => sql`${status}`), sql`, `);
  const result = await tx.execute<{ ticket_id: string; marker: string; since: Date | string }>(sql`
    select t.ticket_id, coalesce(last.message_id::text, 'created') as marker, coalesce(last.created_on, t.created_on) as since
      from hdt_tickets t ${lastHumanMessage}
     where t.status in (${statuses})
       and t.created_on <= ${opts.cutoff.toISOString()}::timestamptz
       and coalesce(last.created_on, t.created_on) <= ${opts.cutoff.toISOString()}::timestamptz
       ${opts.notBefore ? sql`and coalesce(last.created_on, t.created_on) >= ${opts.notBefore.toISOString()}::timestamptz` : sql``}
       ${opts.after && !opts.newest ? sql`and t.ticket_id > ${opts.after}::uuid` : sql``}
     order by ${opts.newest ? sql`t.number desc` : sql`t.ticket_id`}
     limit ${opts.limit}`);
  return result.rows.map((row) => ({ ticketId: row.ticket_id, marker: row.marker, since: new Date(row.since) }));
}

/** Молчание одного обращения сейчас: перепроверка под блокировкой строки перед применением правила. */
export async function silenceOfTx(tx: Tx, ticketId: string): Promise<Silence | null> {
  const result = await tx.execute<{ ticket_id: string; marker: string; since: Date | string }>(sql`
    select t.ticket_id, coalesce(last.message_id::text, 'created') as marker, coalesce(last.created_on, t.created_on) as since
      from hdt_tickets t ${lastHumanMessage}
     where t.ticket_id = ${ticketId}::uuid`);
  const row = result.rows[0];
  return row ? { ticketId: row.ticket_id, marker: row.marker, since: new Date(row.since) } : null;
}

// --- Пробный прогон и журнал срабатываний ---

/** Последние обращения по номеру (он растёт с созданием): для пробного прогона правила. */
export async function recentTicketIdsTx(tx: Tx, limit: number): Promise<string[]> {
  const rows = await tx.select({ ticketId: tickets.ticketId }).from(tickets).orderBy(desc(tickets.number)).limit(limit);
  return rows.map((row) => row.ticketId);
}

/** Ответы людей: публичные сообщения клиента или сотрудника. Автоматические ответы правил пишет система. */
const REPLY_AUTHORS = { client_replied: 'client', staff_replied: 'staff' } as const;
/** Изменения по истории обращения. Изменение, сделанное правилом (отметка byRule), правила администратора не запускает. */
const CHANGE_KINDS = { status_changed: 'status', priority_changed: 'priority', rated: 'rated', sla_breached: 'due' } as const;

/**
 * Какие из обращений пережили событие вида kind (пробный прогон правила; волна 5, задача 2). Смотрится история
 * обращения, а не очередь событий предметной области: та хранится 30 суток. Создание было у каждого обращения.
 * Ответы клиента и сотрудника берутся из сообщений, смена статуса и приоритета, оценка и нарушение срока из событий
 * истории. "Срок скоро" следа в истории не оставляет: он восстанавливается по срокам обращения. Срок считается
 * подошедшим, если момент "скоро" (soonMoment) уже наступил, а срок в этот момент ещё ждали: первого ответа не было,
 * обращение не было решено. Для такого события это приближение: момент мог пройти, пока процесс не работал.
 */
export async function ticketsWithEventTx(tx: Tx, ticketIds: readonly string[], kind: Exclude<DomainEventKind, 'no_activity' | 'ai_handoff'>, now: Date): Promise<Set<string>> {
  const ids = [...new Set(ticketIds)];
  if (ids.length === 0) return new Set();
  if (kind === 'ticket_created') return new Set(ids);
  if (kind === 'client_replied' || kind === 'staff_replied') {
    const rows = await tx
      .selectDistinct({ ticketId: ticketMessages.ticketId })
      .from(ticketMessages)
      .where(and(inArray(ticketMessages.ticketId, ids), eq(ticketMessages.authorType, REPLY_AUTHORS[kind]), eq(ticketMessages.isInternal, false), eq(ticketMessages.isAuto, false)));
    return new Set(rows.map((row) => row.ticketId));
  }
  if (kind === 'sla_soon') {
    const config = await readSlaConfig(tx);
    const rows = await tx
      .select({
        ticketId: tickets.ticketId,
        priority: tickets.priority,
        createdOn: tickets.createdOn,
        firstResponseDueOn: tickets.firstResponseDueOn,
        resolutionDueOn: tickets.resolutionDueOn,
        firstRespondedOn: tickets.firstRespondedOn,
        resolvedOn: tickets.resolvedOn,
      })
      .from(tickets)
      .where(inArray(tickets.ticketId, ids));
    const reached = (due: Date | null, settledOn: Date | null, priority: Priority, createdOn: Date): boolean => {
      const moment = soonMoment(createdOn, due, calendarFor(config, priority));
      return moment !== null && moment.getTime() <= now.getTime() && (settledOn === null || settledOn.getTime() > moment.getTime());
    };
    return new Set(
      rows
        .filter((row) => reached(row.firstResponseDueOn, row.firstRespondedOn, row.priority, row.createdOn) || reached(row.resolutionDueOn, row.resolvedOn, row.priority, row.createdOn))
        .map((row) => row.ticketId),
    );
  }
  const rows = await tx
    .selectDistinct({ ticketId: ticketEvents.ticketId })
    .from(ticketEvents)
    .where(
      and(
        inArray(ticketEvents.ticketId, ids),
        eq(ticketEvents.kind, CHANGE_KINDS[kind]),
        sql`not (${ticketEvents.payload} ? 'byRule')`,
        // Подтверждение приоритета пишет событие истории без смены значения, а событие правил не пишет (проверка волны 5, I1).
        sql`(not (${ticketEvents.payload} ? 'from') or (${ticketEvents.payload} ->> 'from') is distinct from (${ticketEvents.payload} ->> 'to'))`,
      ),
    );
  return new Set(rows.map((row) => row.ticketId));
}

/** Номера обращений по идентификаторам: подписи строк журнала срабатываний. */
export async function ticketNumbersTx(tx: Tx, ticketIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(ticketIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ ticketId: tickets.ticketId, number: tickets.number }).from(tickets).where(inArray(tickets.ticketId, ids));
  return new Map(rows.map((row) => [row.ticketId, row.number]));
}
