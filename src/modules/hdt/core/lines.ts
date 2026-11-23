import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { readSlaConfig } from '@/modules/hdr/api';
import { HdtError } from '../error';
import { DEVELOPMENT_ROLES, type Queue, TRANSFERABLE_STATUSES, type TransferReason } from '../pref';
import { lineTransfers, tickets } from '../schema';
import { addWorkingMinutes } from '../sla';
import { pickupMinutes } from '../util';
import { assertCanWrite, changeAssigneeTx, changeStatusTx, flushTicketTx, lockAgentTicket, recordChange, stageTicket } from './agent-actions';
import { calendarFor } from './sla';

// Модуль hdt, слой core: передача между линиями (FR-LINE-03..07; план M3, задача 9). Передача и возврат одной
// транзакцией: очередь обращения, строка передачи, внутреннее событие "queue" с запиской, запись журнала.
// Сроки перед клиентом не пересчитываются (FR-LINE-05).

export type TransferNote = { reason: TransferReason; checked: string; needed: string; checklist: string[] };

async function dbNow(tx: Tx): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(result.rows[0]?.now ?? Date.now());
}

/**
 * Передать на вторую линию (FR-LINE-03). Только с первой линии и из открытого статуса. Исполнитель снимается:
 * обращение ждёт вторую линию в её очереди. Срок "взять в работу" от момента передачи (FR-LINE-06).
 */
export async function transferToL2Tx(actor: StaffActor, number: number, note: TransferNote, pickupSetting: unknown): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.queue !== 'l1' || !TRANSFERABLE_STATUSES.includes(ticket.status)) throw new HdtError('transition_refused');
    const config = await readSlaConfig(tx);
    const minutes = pickupMinutes(ticket.priority, pickupSetting, config.policies[ticket.priority].firstResponseMinutes);
    const pickupDueOn = addWorkingMinutes(await dbNow(tx), minutes, calendarFor(config, ticket.priority));
    stageTicket(ticket, { queue: 'l2' });
    if (ticket.assigneeId) await changeAssigneeTx(tx, actor, ticket, null, null);
    await flushTicketTx(tx, ticket);
    await tx.insert(lineTransfers).values({
      ticketId: ticket.ticketId,
      fromLine: 'l1',
      toLine: 'l2',
      reasonCode: note.reason,
      checked: note.checked,
      needed: note.needed,
      checklist: note.checklist,
      byUser: actor.userId,
      pickupDueOn,
    });
    await recordChange(tx, actor, ticket, {
      kind: 'queue',
      payload: { from: 'l1', to: 'l2', reason: note.reason, checked: note.checked, needed: note.needed, checklist: note.checklist },
      audit: 'ticket.line_transferred',
    });
    ticket.queue = 'l2';
  });
}

/**
 * Вернуть на первую линию с пояснением (FR-LINE-04): вторая линия, care и admin. Обращение приходит тому, кто
 * его передавал; "В разработке" снова "В работе", разработка это вторая линия (ТЗ 10.5, вычисление линии).
 */
/** Кто последним передавал обращение с первой линии: ему оно вернётся. Читается до транзакции возврата, чтобы имя
 * сотрудника не запрашивалось второй транзакцией внутри первой (аудит 23.11.2026, находка A4). */
export async function lastL1SenderTx(actor: StaffActor, number: number): Promise<string | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ byUser: lineTransfers.byUser })
      .from(lineTransfers)
      .innerJoin(tickets, eq(tickets.ticketId, lineTransfers.ticketId))
      .where(and(eq(tickets.number, number), eq(lineTransfers.fromLine, 'l1')))
      .orderBy(desc(lineTransfers.createdOn))
      .limit(1),
  );
  return rows[0]?.byUser ?? null;
}

export async function returnToL1Tx(actor: StaffActor, number: number, explanation: string, sender: { userId: string; name: string | null } | null): Promise<void> {
  if (!(DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole)) throw new HdtError('forbidden');
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.queue === 'l1' || ticket.status === 'resolved' || ticket.status === 'closed') throw new HdtError('transition_refused');
    const [last] = await tx
      .select({ byUser: lineTransfers.byUser })
      .from(lineTransfers)
      .where(and(eq(lineTransfers.ticketId, ticket.ticketId), eq(lineTransfers.fromLine, 'l1')))
      .orderBy(desc(lineTransfers.createdOn))
      .limit(1);
    const from = ticket.queue as Queue;
    stageTicket(ticket, { queue: 'l1' });
    await tx.insert(lineTransfers).values({ ticketId: ticket.ticketId, fromLine: from, toLine: 'l1', explanation, byUser: actor.userId });
    await recordChange(tx, actor, ticket, { kind: 'queue', payload: { from, to: 'l1', explanation }, audit: 'ticket.line_returned' });
    ticket.queue = 'l1';
    if (ticket.status === 'in_development') await changeStatusTx(tx, actor, ticket, 'in_progress');
    // Имя прочитано до транзакции. Если за это время обращение передавал кто-то другой, событие пишется без имени.
    if (last && last.byUser !== ticket.assigneeId) await changeAssigneeTx(tx, actor, ticket, last.byUser, sender?.userId === last.byUser ? sender.name : null);
    await flushTicketTx(tx, ticket);
  });
}
