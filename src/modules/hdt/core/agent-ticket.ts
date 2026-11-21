import 'server-only';
import { and, asc, desc, eq, like, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { attachments, lineTransfers, ticketEvents, ticketMessages, ticketReads, tickets } from '../schema';

// Модуль hdt, слой core: обращение глазами сотрудника (FR-AG-04, FR-AG-05, UX-A-15; план M3, задача 6).
// Сотрудник видит всё: заметки, внутренние события, файлы любого состояния (5.3). Скачать можно только чистый файл.

export type AgentTicketRecord = typeof tickets.$inferSelect;
export type AgentMessageRecord = Pick<typeof ticketMessages.$inferSelect, 'messageId' | 'authorId' | 'authorType' | 'body' | 'isInternal' | 'createdOn'>;
export type AgentEventRecord = Pick<typeof ticketEvents.$inferSelect, 'eventId' | 'kind' | 'actorType' | 'actorId' | 'payload' | 'isInternal' | 'createdOn'>;
export type AgentAttachmentRecord = Pick<
  typeof attachments.$inferSelect,
  'attachmentId' | 'messageId' | 'uploaderId' | 'fileName' | 'mime' | 'size' | 'scanStatus' | 'scanSignature' | 'isInternal' | 'createdOn'
>;

export async function readAgentTicketTx(
  actor: StaffActor,
  number: number,
): Promise<{
  ticket: AgentTicketRecord;
  messages: AgentMessageRecord[];
  events: AgentEventRecord[];
  attachments: AgentAttachmentRecord[];
  seenOn: Date | null;
  transfer: { toLine: string; pickupDueOn: Date | null; pickedUpOn: Date | null } | null;
} | null> {
  return withActor(actor, async (tx) => {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.number, number)).limit(1);
    if (!ticket) return null;
    const messages = await tx
      .select({
        messageId: ticketMessages.messageId,
        authorId: ticketMessages.authorId,
        authorType: ticketMessages.authorType,
        body: ticketMessages.body,
        isInternal: ticketMessages.isInternal,
        createdOn: ticketMessages.createdOn,
      })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticket.ticketId))
      .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
    const events = await tx
      .select({
        eventId: ticketEvents.eventId,
        kind: ticketEvents.kind,
        actorType: ticketEvents.actorType,
        actorId: ticketEvents.actorId,
        payload: ticketEvents.payload,
        isInternal: ticketEvents.isInternal,
        createdOn: ticketEvents.createdOn,
      })
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticket.ticketId))
      .orderBy(asc(ticketEvents.createdOn), asc(ticketEvents.eventId));
    const files = await tx
      .select({
        attachmentId: attachments.attachmentId,
        messageId: attachments.messageId,
        uploaderId: attachments.uploaderId,
        fileName: attachments.fileName,
        mime: attachments.mime,
        size: attachments.size,
        scanStatus: attachments.scanStatus,
        scanSignature: attachments.scanSignature,
        isInternal: attachments.isInternal,
        createdOn: attachments.createdOn,
      })
      .from(attachments)
      .where(eq(attachments.ticketId, ticket.ticketId))
      .orderBy(asc(attachments.createdOn), asc(attachments.attachmentId));
    const [transfer] = await tx
      .select({ toLine: lineTransfers.toLine, pickupDueOn: lineTransfers.pickupDueOn, pickedUpOn: lineTransfers.pickedUpOn })
      .from(lineTransfers)
      .where(eq(lineTransfers.ticketId, ticket.ticketId))
      .orderBy(desc(lineTransfers.createdOn))
      .limit(1);
    const [read] = await tx
      .select({ seenOn: ticketReads.seenOn })
      .from(ticketReads)
      .where(and(eq(ticketReads.ticketId, ticket.ticketId), eq(ticketReads.userId, actor.userId)));
    return { ticket, messages, events, attachments: files, seenOn: read?.seenOn ?? null, transfer: transfer ?? null };
  });
}

/** Отметка просмотра: своя строка сотрудника, время базы. */
export async function markReadTx(actor: StaffActor, ticketId: string): Promise<void> {
  await withActor(actor, (tx) =>
    tx
      .insert(ticketReads)
      .values({ ticketId, userId: actor.userId, seenOn: sql`now()` })
      .onConflictDoUpdate({ target: [ticketReads.ticketId, ticketReads.userId], set: { seenOn: sql`now()` } }),
  );
}

/** Файл, который сотрудник может открыть: проверенный чистый и уже перенесённый из карантина. */
export async function findStaffDownloadableTx(actor: StaffActor, attachmentId: string): Promise<{ storageKey: string; fileName: string; mime: string } | null> {
  const [row] = await withActor(actor, (tx) =>
    tx
      .select({ storageKey: attachments.storageKey, fileName: attachments.fileName, mime: attachments.mime })
      .from(attachments)
      .where(and(eq(attachments.attachmentId, attachmentId), eq(attachments.scanStatus, 'clean'), like(attachments.storageKey, 'files/%')))
      .limit(1),
  );
  return row ?? null;
}
