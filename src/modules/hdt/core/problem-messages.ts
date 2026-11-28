import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { emitEventTx, writeAudit } from '@/modules/hdc/api';
import { type ResolutionType, type TicketStatus } from '../pref';
import { ticketEvents, ticketMessages, tickets } from '../schema';
import { lockRuleTicketTx } from './automation';
import { notifyTicketTx } from './notify';
import { refreshSla } from './sla';

// Модуль hdt, слой core: сообщение рассылки по известной проблеме в обращении (ТЗ FR-KP-06, 07, 11.14; план M5c,
// задача 5, решения 18-20). Пишет задача problems.broadcast от имени системы, автор сообщения сотрудник рассылки.
//
// Сообщение это публичный ответ сотрудника: останавливает срок первого ответа и снимает "клиент ждёт с" (FR-SLA-04),
// но не меняет исполнителя, очередь и статус (решение 19). Закрытие (решение 20): после итогового сообщения обращение
// переходит в "Решено" разрешёнными переходами таблицы 7.2 ("Новое" через "В работе"), каждый переход с событием
// истории и записью журнала. Вторую строку "обращение, рассылка" не даёт уникальный индекс hdt_ticket_messages_u2:
// при конфликте ничего не пишется, ни письма, ни перехода.

const OPEN: readonly TicketStatus[] = ['new', 'in_progress', 'waiting_customer', 'in_development'];

export type ProblemMessageInput = {
  ticketId: string;
  broadcastId: string;
  /** Сотрудник, написавший рассылку: от его имени сообщение. */
  authorId: string;
  body: string;
  problemRef: string;
  problemStatus: string;
  resolve?: { resolutionType: ResolutionType; version: string | null } | null;
};

export type ProblemMessageResult = 'delivered' | 'exists' | 'skipped';

async function statusTx(tx: Tx, ticket: { ticketId: string; orgId: string }, from: TicketStatus, to: TicketStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const payload = { from, to, ...extra, byProblem: true };
  await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'system', payload, isInternal: false });
  await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: payload });
  // Событие для правил автоматизации и вебхуков в той же транзакции (FR-AUTO-02; проверка качества, Q14).
  await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from, to } });
}

/**
 * Сообщение рассылки в одном обращении в транзакции системы. Обращение заблокировано; закрытое, объединённое и уже
 * отвязанное от проблемы получает skipped; сообщение этой рассылки уже есть: exists.
 */
export async function postProblemMessageTx(tx: Tx, input: ProblemMessageInput & { problemId: string }): Promise<ProblemMessageResult> {
  const ticket = await lockRuleTicketTx(tx, input.ticketId);
  if (!ticket) return 'skipped';
  const [linked] = await tx.select({ problemId: tickets.knownProblemId }).from(tickets).where(eq(tickets.ticketId, input.ticketId)).limit(1);
  if (!OPEN.includes(ticket.status) || ticket.mergedIntoId || linked?.problemId !== input.problemId) return 'skipped';
  const inserted = await tx.execute<{ message_id: string }>(sql`
    insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, broadcast_id)
    values (${ticket.orgId}, ${ticket.ticketId}, ${input.authorId}, 'staff', ${input.body}, false, ${input.broadcastId})
    on conflict (ticket_id, broadcast_id) where broadcast_id is not null do nothing
    returning message_id`);
  const messageId = inserted.rows[0]?.message_id;
  if (!messageId) return 'exists';
  const now = new Date();
  const set = { firstRespondedOn: sql`coalesce(${tickets.firstRespondedOn}, now())`, clientWaitingSince: null };
  if (input.resolve) {
    let from = ticket.status;
    if (from === 'new') {
      await statusTx(tx, ticket, 'new', 'in_progress');
      from = 'in_progress';
    }
    await statusTx(tx, ticket, from, 'resolved', { resolution: input.resolve.resolutionType });
    await refreshSla(tx, ticket.ticketId, now, {
      ...set,
      status: 'resolved',
      resolutionType: input.resolve.resolutionType,
      resolvedVersion: input.resolve.resolutionType === 'fixed_in_version' ? input.resolve.version : null,
      resolvedOn: sql`now()`,
    });
  } else {
    await tx.update(tickets).set(set).where(eq(tickets.ticketId, ticket.ticketId));
  }
  // Письмо и сообщение бота отдельным видом "обновление по известной проблеме" (FR-NT-12, 14).
  await notifyTicketTx(tx, {
    ticketId: ticket.ticketId,
    kind: 'problem_update',
    actorUserId: input.authorId,
    messageId,
    problemUpdate: { problemRef: input.problemRef, problemStatus: input.problemStatus, closing: Boolean(input.resolve) },
  });
  return 'delivered';
}

/** Сколько обращений получили сообщение рассылки. */
export async function broadcastDeliveredTx(tx: Tx, broadcastId: string): Promise<{ delivered: number; ticketIds: Set<string> }> {
  const rows = await tx.select({ ticketId: ticketMessages.ticketId }).from(ticketMessages).where(eq(ticketMessages.broadcastId, broadcastId));
  return { delivered: rows.length, ticketIds: new Set(rows.map((r) => r.ticketId)) };
}
