import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { type AuditAction, emitEventTx, writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import {
  canTransition,
  DEVELOPMENT_ROLES,
  type EventKind,
  type Priority,
  type ResolutionType,
  STAFF_WRITE_ROLES,
  type TicketStatus,
  type TicketType,
} from '../pref';
import { lineTransfers, ticketEvents, tickets } from '../schema';
import { assertUnchangedTx } from './changes';
import { refreshSla, type TicketPatch } from './sla';
import { notifyTicketTx, oncallP1Tx } from './notify';

// Модуль hdt, слой core: действия сотрудника с обращением (FR-AG-02, 04, 09, 13, FR-SLA-03, раздел 7.2;
// план M3, задача 7). Каждое действие одной транзакцией: строка обращения блокируется, меняется фиксированный
// набор колонок, пишутся событие истории и запись журнала аудита. Клиенту видно только событие статуса.

export type LockedTicket = {
  ticketId: string;
  orgId: string;
  number: number;
  status: TicketStatus;
  priority: Priority;
  type: TicketType;
  moduleId: string | null;
  assigneeId: string | null;
  queue: string;
  snoozedUntil: Date | null;
  snoozeReturnedOn: Date | null;
  mergedIntoId: string | null;
};

/** Роли, которые ведут обращения: product только читает (ТЗ 5.2, миграция 0021). */
export function assertCanWrite(actor: StaffActor): void {
  if (!(STAFF_WRITE_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdtError('forbidden');
}

/** Обращение по номеру с блокировкой строки. Нет такого: not_found. */
export async function lockAgentTicket(tx: Tx, number: number): Promise<LockedTicket> {
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
    .where(eq(tickets.number, number))
    .limit(1)
    .for('update');
  if (!row) throw new HdtError('not_found');
  return row;
}

/**
 * Изменения строки обращения, накопленные действием. Одно действие сотрудника меняет несколько полей по очереди
 * (первый ответ, исполнитель, статус), и раньше каждое поле писалось своим обновлением, а сроки ещё одним: четыре
 * версии строки на один ответ (аудит 23.11.2026, находка P8). Теперь поля копятся и пишутся один раз.
 */
const staged = new WeakMap<LockedTicket, { set: TicketPatch; sla: boolean }>();

/** Отложить изменение строки до записи в конце действия. sla: от этих полей зависят сроки (статус, приоритет). */
export function stageTicket(ticket: LockedTicket, set: TicketPatch, opts: { sla?: boolean } = {}): void {
  const pending = staged.get(ticket) ?? { set: {}, sla: false };
  staged.set(ticket, { set: { ...pending.set, ...set }, sla: pending.sla || opts.sla === true });
}

/**
 * Записать накопленное одним обновлением, вместе с пересчётом сроков, если менялись статус или приоритет.
 * Вызывается после записи событий действия и до чтений, которым нужна новая строка (уведомления, дежурные).
 * Нечего писать: обновления нет.
 */
export async function flushTicketTx(tx: Tx, ticket: LockedTicket): Promise<void> {
  const pending = staged.get(ticket);
  staged.delete(ticket);
  // Действие сотрудника снимает пометку "вернулось из отложенных" тем же обновлением (FR-AG-13).
  const set: TicketPatch = { ...(pending?.set ?? {}), ...(ticket.snoozeReturnedOn ? { snoozeReturnedOn: null } : {}) };
  if (Object.keys(set).length === 0) return;
  ticket.snoozeReturnedOn = null;
  if (pending?.sla) await refreshSla(tx, ticket.ticketId, new Date(), set);
  else await tx.update(tickets).set(set).where(eq(tickets.ticketId, ticket.ticketId));
}

/** Событие истории и запись журнала в транзакции действия. Видимо клиенту только событие статуса. */
export async function recordChange(
  tx: Tx,
  actor: StaffActor,
  ticket: LockedTicket,
  change: { kind: EventKind; payload: Record<string, unknown>; audit: AuditAction },
): Promise<void> {
  await tx.insert(ticketEvents).values({
    orgId: ticket.orgId,
    ticketId: ticket.ticketId,
    kind: change.kind,
    actorType: 'staff',
    actorId: actor.userId,
    payload: change.payload,
    isInternal: change.kind !== 'status',
  });
  await writeAudit(tx, { action: change.audit, objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: change.payload });
}

/** Переход статуса по таблице 7.2 с событием и аудитом. Строка и сроки пишутся в flushTicketTx. */
export async function changeStatusTx(
  tx: Tx,
  actor: StaffActor,
  ticket: LockedTicket,
  to: TicketStatus,
  opts: { resolution?: ResolutionType; version?: string } = {},
): Promise<void> {
  // Объединённое закрыто навсегда (решение 4); закрывает сотрудник только решённое (решение 5).
  if (ticket.mergedIntoId) throw new HdtError('merged');
  if (!canTransition(ticket.status, to) || (to === 'closed' && ticket.status !== 'resolved')) throw new HdtError('transition_refused');
  if (to === 'in_development' && !(DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdtError('forbidden');
  if (to === 'resolved' && (!opts.resolution || (opts.resolution === 'fixed_in_version' && !opts.version))) throw new HdtError('resolution_required');
  stageTicket(
    ticket,
    {
      status: to,
      ...(to === 'resolved'
        ? { resolutionType: opts.resolution, resolvedVersion: opts.resolution === 'fixed_in_version' ? (opts.version ?? null) : null, resolvedOn: sql`now()` }
        : {}),
      ...(to === 'closed' ? { closedOn: sql`now()` } : {}),
    },
    { sla: true },
  );
  const payload: Record<string, unknown> = { from: ticket.status, to };
  if (to === 'resolved') payload.resolution = opts.resolution;
  await recordChange(tx, actor, ticket, { kind: 'status', payload, audit: 'ticket.status_changed' });
  // Событие для правил автоматизации в той же транзакции (FR-AUTO-02).
  await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from: ticket.status, to } });
  ticket.status = to;
}

/** Исполнитель с событием и аудитом. Тот же исполнитель: ничего не меняется. */
export async function changeAssigneeTx(tx: Tx, actor: StaffActor, ticket: LockedTicket, assigneeId: string | null, assigneeName: string | null): Promise<void> {
  if (ticket.assigneeId === assigneeId) return;
  stageTicket(ticket, { assigneeId });
  await recordChange(tx, actor, ticket, { kind: 'assignee', payload: { from: ticket.assigneeId, to: assigneeId, toName: assigneeName }, audit: 'ticket.assigned' });
  ticket.assigneeId = assigneeId;
}

/**
 * Вторая линия взялась за обращение (FR-LINE-06): первое "Взять себе" или ответ сотрудника второй линии
 * отмечает открытую передачу на вторую линию. Повторное действие отметку не меняет.
 */
export async function markPickedUpTx(tx: Tx, actor: StaffActor, ticket: LockedTicket): Promise<void> {
  if (ticket.queue === 'l1' || !(DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole)) return;
  await tx
    .update(lineTransfers)
    .set({ pickedUpOn: sql`now()`, pickedUpBy: actor.userId })
    .where(and(eq(lineTransfers.ticketId, ticket.ticketId), eq(lineTransfers.fromLine, 'l1'), isNull(lineTransfers.pickedUpOn)));
}

/** "Взять себе" (FR-AG-02): исполнитель я, новое становится "В работе". Уже взял другой: already_taken. */
export async function takeTx(actor: StaffActor, number: number, myName: string): Promise<{ ticketId: string }> {
  assertCanWrite(actor);
  return withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    // Обращение на второй линии берёт вторая линия (решение 0031, пункт 15): иначе она не смогла бы его взять.
    if (ticket.queue !== 'l1' && !(DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdtError('forbidden');
    if (ticket.assigneeId && ticket.assigneeId !== actor.userId) throw new HdtError('already_taken', { holderId: ticket.assigneeId });
    await changeAssigneeTx(tx, actor, ticket, actor.userId, myName);
    if (ticket.status === 'new') await changeStatusTx(tx, actor, ticket, 'in_progress');
    await flushTicketTx(tx, ticket);
    await markPickedUpTx(tx, actor, ticket);
    return { ticketId: ticket.ticketId };
  });
}

export async function assignTx(actor: StaffActor, number: number, assignee: { id: string; name: string } | null, seen?: Date): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    await assertUnchangedTx(tx, ticket.ticketId, seen, actor.userId);
    await changeAssigneeTx(tx, actor, ticket, assignee?.id ?? null, assignee?.name ?? null);
    await flushTicketTx(tx, ticket);
  });
}

export async function setStatusTx(
  actor: StaffActor,
  number: number,
  to: TicketStatus,
  opts: { resolution?: ResolutionType; version?: string; seen?: Date },
): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    await assertUnchangedTx(tx, ticket.ticketId, opts.seen, actor.userId);
    await changeStatusTx(tx, actor, ticket, to, opts);
    await flushTicketTx(tx, ticket);
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: to === 'resolved' ? 'resolved' : 'status', actorUserId: actor.userId, to });
  });
}

/** Приоритет с причиной (FR-SLA-03): подтверждён, сроки пересчитаны от создания. Тот же приоритет: подтверждение. */
export async function setPriorityTx(actor: StaffActor, number: number, priority: Priority, reason: string, seen?: Date): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    await assertUnchangedTx(tx, ticket.ticketId, seen, actor.userId);
    stageTicket(ticket, { priority, priorityConfirmed: true }, { sla: true });
    await recordChange(tx, actor, ticket, { kind: 'priority', payload: { from: ticket.priority, to: priority, reason }, audit: 'ticket.priority_changed' });
    // Тот же приоритет это подтверждение, а не изменение: события для правил нет. Причина в событие не идёт: это текст сотрудника.
    if (ticket.priority !== priority) await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'priority_changed', payload: { from: ticket.priority, to: priority } });
    await flushTicketTx(tx, ticket);
    // Поднятие до P1 до первого ответа: дежурным одно сообщение (FR-SLA-07).
    await oncallP1Tx(tx, ticket.ticketId);
  });
}

export async function setTypeTx(actor: StaffActor, number: number, type: TicketType): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.type === type) return;
    await tx.update(tickets).set({ type }).where(eq(tickets.ticketId, ticket.ticketId));
    await recordChange(tx, actor, ticket, { kind: 'type', payload: { from: ticket.type, to: type }, audit: 'ticket.type_changed' });
  });
}

export async function setModuleTx(actor: StaffActor, number: number, moduleId: string | null): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.moduleId === moduleId) return;
    await tx.update(tickets).set({ moduleId }).where(eq(tickets.ticketId, ticket.ticketId));
    await recordChange(tx, actor, ticket, { kind: 'module', payload: { from: ticket.moduleId, to: moduleId }, audit: 'ticket.module_changed' });
  });
}

/** Отложить до момента (FR-AG-13): сроки не останавливаются. null снимает отложение. */
export async function snoozeTx(actor: StaffActor, number: number, until: Date | null): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    await tx.update(tickets).set({ snoozedUntil: until, snoozeReturnedOn: null }).where(eq(tickets.ticketId, ticket.ticketId));
    await recordChange(tx, actor, ticket, { kind: 'snooze', payload: { until: until?.toISOString() ?? null }, audit: 'ticket.snoozed' });
  });
}
