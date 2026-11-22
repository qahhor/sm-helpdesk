import 'server-only';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { ticketEvents, tickets } from '../schema';
import { assertCanWrite } from './agent-actions';
import { refreshSla } from './sla';
import { notifyTicketTx } from './notify';

// Модуль hdt, слой core: объединение дублей (FR-AG-07; план M3, задача 11, решение 4). Дубль закрывается из любого
// открытого статуса: единственное исключение из таблицы 7.2. Объединение только внутри одной организации и к конечному
// основному обращению. Клиент дубля видит событие "объединено"; номер основного страница покажет, только если основное
// ему видно, поэтому в событии дубля номера нет. В основном обращении событие внутреннее.

type Node = { ticketId: string; orgId: string; number: number; status: string; mergedIntoId: string | null };

const MAX_CHAIN = 20;

async function lockByNumbers(tx: Tx, numbers: number[]): Promise<Node[]> {
  // Строки блокируются в одном порядке: два встречных объединения не ждут друг друга бесконечно.
  return tx
    .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, number: tickets.number, status: tickets.status, mergedIntoId: tickets.mergedIntoId })
    .from(tickets)
    .where(inArray(tickets.number, numbers))
    .orderBy(asc(tickets.ticketId))
    .for('update');
}

async function lockById(tx: Tx, ticketId: string): Promise<Node | undefined> {
  const [row] = await tx
    .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, number: tickets.number, status: tickets.status, mergedIntoId: tickets.mergedIntoId })
    .from(tickets)
    .where(eq(tickets.ticketId, ticketId))
    .for('update');
  return row;
}

/** Объединить дубль с основным. Возвращает номер конечного основного обращения. */
export async function mergeTx(actor: StaffActor, number: number, intoNumber: number): Promise<number> {
  assertCanWrite(actor);
  return withActor(actor, async (tx) => {
    const locked = await lockByNumbers(tx, [number, intoNumber]);
    const dup = locked.find((t) => t.number === number);
    let main = locked.find((t) => t.number === intoNumber);
    if (!dup || !main) throw new HdtError('not_found');
    // Цепочка разворачивается к конечному основному.
    for (let step = 0; main.mergedIntoId && step < MAX_CHAIN; step++) {
      const next = await lockById(tx, main.mergedIntoId);
      if (!next) throw new HdtError('not_found');
      main = next;
    }
    if (main.mergedIntoId || main.ticketId === dup.ticketId || main.orgId !== dup.orgId) throw new HdtError('merge_refused');
    if (dup.status === 'closed' || main.status === 'closed') throw new HdtError('transition_refused');
    await tx
      .update(tickets)
      .set({
        status: 'closed',
        closedOn: sql`now()`,
        resolvedOn: sql`coalesce(${tickets.resolvedOn}, now())`,
        resolutionType: 'duplicate',
        mergedIntoId: main.ticketId,
        snoozedUntil: null,
      })
      .where(eq(tickets.ticketId, dup.ticketId));
    await tx.insert(ticketEvents).values([
      { orgId: dup.orgId, ticketId: dup.ticketId, kind: 'status', actorType: 'staff', actorId: actor.userId, payload: { from: dup.status, to: 'closed' } },
      { orgId: dup.orgId, ticketId: dup.ticketId, kind: 'merge', actorType: 'staff', actorId: actor.userId, payload: {} },
      { orgId: main.orgId, ticketId: main.ticketId, kind: 'merge', actorType: 'staff', actorId: actor.userId, payload: { from: dup.number }, isInternal: true },
    ]);
    await writeAudit(tx, { action: 'ticket.merged', objectType: 'ticket', objectId: dup.ticketId, orgId: dup.orgId, diff: { into: main.number } });
    await writeAudit(tx, { action: 'ticket.merged', objectType: 'ticket', objectId: main.ticketId, orgId: main.orgId, diff: { from: dup.number } });
    await refreshSla(tx, dup.ticketId, new Date());
    await notifyTicketTx(tx, { ticketId: dup.ticketId, kind: 'merged', actorUserId: actor.userId, mergedInto: main.number });
    return main.number;
  });
}
