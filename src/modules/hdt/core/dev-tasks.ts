import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { StaffActor } from '@/db/with-actor';
import { moduleCodesTx } from '@/modules/hdr/api';
import { lineLeads } from '@/modules/hdu/api/recipients';
import { HdtError } from '../error';
import { DEVELOPMENT_ROLES, type Priority, type TicketStatus, type TicketType } from '../pref';
import { ticketEvents, tickets } from '../schema';
import { assertCanWrite, changeStatusTx, flushTicketTx, lockAgentTicket, type LockedTicket } from './agent-actions';
import { notifyTicketTx } from './notify';

// Модуль hdt, слой core: то, что передача в разработку делает с обращением (ТЗ 7.9, FR-DEV-02, 05; план M8,
// задача 7). Задачи разработки и привязки ведёт модуль hdw и вызывает эти функции из своей транзакции: статус
// "В разработке" ставится тем же действием сотрудника, что и вручную (переход по таблице 7.2, история, журнал,
// сроки, событие для правил, письмо клиенту). Запись истории о задаче всегда внутренняя: клиент её не видит.

/** Передавать в разработку могут роли, которым разрешён статус "В разработке" (ТЗ 5.2). */
export function assertCanDevelop(actor: StaffActor): void {
  assertCanWrite(actor);
  if (!(DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdtError('forbidden');
}

/** Обращение по номеру с блокировкой строки для передачи в разработку. Нет такого: not_found. */
export async function devLockTicketTx(tx: Tx, actor: StaffActor, number: number): Promise<LockedTicket> {
  assertCanDevelop(actor);
  return lockAgentTicket(tx, number);
}

/**
 * Статус "В разработке" действием сотрудника. Уже "В разработке": ничего не меняется (false). Иначе переход по
 * таблице 7.2 с событием истории, записью журнала, пересчётом сроков, событием для правил и письмом клиенту.
 */
export async function devHandOverTx(tx: Tx, actor: StaffActor, ticket: LockedTicket): Promise<boolean> {
  assertCanDevelop(actor);
  if (ticket.mergedIntoId) throw new HdtError('merged');
  if (ticket.status === 'in_development') return false;
  await changeStatusTx(tx, actor, ticket, 'in_development');
  await flushTicketTx(tx, ticket);
  await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'status', actorUserId: actor.userId, to: 'in_development' });
  return true;
}

/** Можно ли передать обращение в разработку прямо сейчас: проверка до обращения к таск-менеджеру, без блокировки. */
function assertCanHandOver(ticket: { status: TicketStatus; mergedIntoId: string | null }): void {
  if (ticket.mergedIntoId) throw new HdtError('merged');
  if (ticket.status !== 'in_progress' && ticket.status !== 'in_development') throw new HdtError('transition_refused');
}

/** Внутренняя запись истории о задаче разработки. actor: сотрудник; null: система (вебхук, опрос таск-менеджера). */
export async function devTaskHistoryTx(tx: Tx, ticket: { ticketId: string; orgId: string }, actor: StaffActor | null, payload: Record<string, unknown>): Promise<void> {
  await tx.insert(ticketEvents).values({
    orgId: ticket.orgId,
    ticketId: ticket.ticketId,
    kind: 'dev_task',
    actorType: actor ? 'staff' : 'system',
    actorId: actor?.userId ?? null,
    payload,
    isInternal: true,
  });
}

/**
 * Задача разработки закрыта (FR-DEV-05): каждому обращению из списка, которое ещё "В разработке", внутренняя запись
 * истории и напоминание исполнителю, а без исполнителя руководителям линии обращения (как при нарушении срока).
 * Статус обращения не меняется. Возвращает число обращений, по которым ушло напоминание.
 */
export async function devTaskClosedTx(tx: Tx, ticketIds: readonly string[], task: { ref: string; status: string; version: string | null }, actor: StaffActor | null): Promise<number> {
  const ids = [...new Set(ticketIds)];
  if (ids.length === 0) return 0;
  const rows = await tx
    .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, queue: tickets.queue, assigneeId: tickets.assigneeId })
    .from(tickets)
    .where(and(inArray(tickets.ticketId, ids), eq(tickets.status, 'in_development')))
    .orderBy(tickets.number);
  const leads = new Map<'l1' | 'l2', string[]>();
  for (const row of rows) {
    let recipients = row.assigneeId ? [row.assigneeId] : null;
    if (!recipients) {
      const line = row.queue === 'l1' ? 'l1' : 'l2';
      recipients = leads.get(line) ?? (await lineLeads(line));
      leads.set(line, recipients);
    }
    await notifyTicketTx(tx, { ticketId: row.ticketId, kind: 'dev_task_closed', actorUserId: null, leads: recipients, devTaskRef: task.ref });
    await devTaskHistoryTx(tx, row, actor, { action: 'closed', ref: task.ref, status: task.status, ...(task.version ? { version: task.version } : {}) });
  }
  return rows.length;
}

/** Обращение по номеру глазами сотрудника: идентификаторы для чтения привязки. Нет такого: null. */
export async function devTicketRefTx(tx: Tx, number: number): Promise<{ ticketId: string; orgId: string } | null> {
  const [row] = await tx.select({ ticketId: tickets.ticketId, orgId: tickets.orgId }).from(tickets).where(eq(tickets.number, number)).limit(1);
  return row ?? null;
}

/** То, что уходит в таск-менеджер Smartup при создании задачи (FR-DEV-03): без вложений и переписки. */
export type DevTaskSource = {
  ticketId: string;
  number: number;
  title: string;
  description: string;
  type: TicketType;
  priority: Priority;
  moduleCode: string | null;
  status: TicketStatus;
  mergedIntoId: string | null;
};

/**
 * Проверка до обращения к таск-менеджеру (режим API): роль, обращение есть, не объединено, из его статуса есть
 * переход "В разработке". Возвращает то, что уйдёт в задачу. Строку не блокирует: окончательно всё проверяет
 * транзакция привязки. Отказы те же, что у передачи: forbidden, not_found, merged, transition_refused.
 */
export async function devHandOverSourceTx(tx: Tx, actor: StaffActor, number: number): Promise<DevTaskSource> {
  assertCanDevelop(actor);
  const source = await devTaskSourceTx(tx, number);
  if (!source) throw new HdtError('not_found');
  assertCanHandOver(source);
  return source;
}

/** Поля обращения для задачи в таск-менеджере. Нет такого: null. */
async function devTaskSourceTx(tx: Tx, number: number): Promise<DevTaskSource | null> {
  const [row] = await tx
    .select({
      ticketId: tickets.ticketId,
      number: tickets.number,
      title: tickets.title,
      description: tickets.description,
      type: tickets.type,
      priority: tickets.priority,
      moduleId: tickets.moduleId,
      status: tickets.status,
      mergedIntoId: tickets.mergedIntoId,
    })
    .from(tickets)
    .where(eq(tickets.number, number))
    .limit(1);
  if (!row) return null;
  const { moduleId, ...rest } = row;
  const moduleCode = moduleId ? ((await moduleCodesTx(tx, [moduleId])).get(moduleId) ?? null) : null;
  return { ...rest, moduleCode };
}
