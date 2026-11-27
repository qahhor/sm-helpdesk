import 'server-only';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import type { Tag } from '@/modules/hdr/api';
import { attachments, lineTransfers, ticketEvents, ticketMessages, ticketReads, tickets } from '../schema';
import { finalMainNumberTx } from './merged-into';
import { ticketTagsTx } from './tags';
import { type TimelineWindow, timelineWindowTx } from './timeline';

// Модуль hdt, слой core: обращение глазами сотрудника (FR-AG-04, FR-AG-05, UX-A-15; план M3, задача 6).
// Сотрудник видит всё: заметки, внутренние события, файлы любого состояния (5.3). Скачать можно только чистый файл.

/** Открытие обращения сотрудником пишется в журнал аудита не чаще раза в это число минут на пару сотрудник и обращение. */
const VIEW_LOG_EVERY_MIN = 60;

export type AgentTicketRecord = typeof tickets.$inferSelect;
export type AgentMessageRecord = Pick<typeof ticketMessages.$inferSelect, 'messageId' | 'authorId' | 'authorType' | 'body' | 'isInternal' | 'createdOn' | 'isAuto'> & { aiKind: string | null };
export type AgentEventRecord = Pick<typeof ticketEvents.$inferSelect, 'eventId' | 'kind' | 'actorType' | 'actorId' | 'payload' | 'isInternal' | 'createdOn'>;
export type AgentAttachmentRecord = Pick<
  typeof attachments.$inferSelect,
  'attachmentId' | 'messageId' | 'uploaderId' | 'fileName' | 'mime' | 'size' | 'scanStatus' | 'scanSignature' | 'isInternal' | 'createdOn'
>;

export async function readAgentTicketTx(
  actor: StaffActor,
  number: number,
  limit: number,
): Promise<{
  ticket: AgentTicketRecord;
  messages: AgentMessageRecord[];
  events: AgentEventRecord[];
  attachments: AgentAttachmentRecord[];
  seenOn: Date | null;
  /** Окно истории: порядок записей, есть ли записи раньше, время самой новой записи всей истории. */
  window: Pick<TimelineWindow, 'order' | 'hasEarlier' | 'latestOn'>;
  transfer: { toLine: string; pickupDueOn: Date | null; pickedUpOn: Date | null } | null;
  mergedIntoNumber: number | null;
  tags: Tag[];
} | null> {
  return withActor(actor, async (tx) => {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.number, number)).limit(1);
    if (!ticket) return null;
    // Последние записи истории, а не вся переписка (аудит 23.11.2026, находка P11).
    const window = await timelineWindowTx(tx, ticket.ticketId, limit, { skipCreated: true });
    const messages = window.messageIds.length === 0 ? [] : await tx
      .select({
        messageId: ticketMessages.messageId,
        authorId: ticketMessages.authorId,
        authorType: ticketMessages.authorType,
        body: ticketMessages.body,
        isInternal: ticketMessages.isInternal,
        createdOn: ticketMessages.createdOn,
        isAuto: ticketMessages.isAuto,
        aiKind: sql<string | null>`${ticketMessages.aiPayload} ->> 'kind'`,
      })
      .from(ticketMessages)
      .where(inArray(ticketMessages.messageId, window.messageIds))
      .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
    const events = window.eventIds.length === 0 ? [] : await tx
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
      .where(inArray(ticketEvents.eventId, window.eventIds))
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
    // Чтение обращения сотрудником оставляет след в журнале аудита (аудит 23.11.2026, находка S8), не чаще раза
    // в час на пару сотрудник и обращение. Запись идёт на сервере в транзакции чтения: от действий страницы она
    // не зависит, её нельзя пропустить, отключив скрипты. Отметку "просмотрено" (seen_on) эта запись не трогает.
    const due = sql`${ticketReads.viewLoggedOn} is null or ${ticketReads.viewLoggedOn} < now() - make_interval(mins => ${VIEW_LOG_EVERY_MIN})`;
    const logged = await tx
      .insert(ticketReads)
      .values({ ticketId: ticket.ticketId, userId: actor.userId, viewLoggedOn: sql`now()` })
      .onConflictDoUpdate({ target: [ticketReads.ticketId, ticketReads.userId], set: { viewLoggedOn: sql`now()` }, setWhere: due })
      .returning({ ticketId: ticketReads.ticketId });
    if (logged.length > 0)
      await writeAudit(tx, { action: 'ticket.viewed_by_staff', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: { number: ticket.number } });
    const mergedIntoNumber = await finalMainNumberTx(tx, ticket.mergedIntoId);
    const tags = (await ticketTagsTx(tx, [ticket.ticketId])).get(ticket.ticketId) ?? [];
    return { ticket, messages, events, attachments: files, seenOn: read?.seenOn ?? null, window, transfer: transfer ?? null, mergedIntoNumber, tags };
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
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ storageKey: attachments.storageKey, fileName: attachments.fileName, mime: attachments.mime, orgId: attachments.orgId, ticketId: attachments.ticketId })
      .from(attachments)
      .where(and(eq(attachments.attachmentId, attachmentId), eq(attachments.scanStatus, 'clean'), like(attachments.storageKey, 'files/%')))
      .limit(1);
    if (!row) return null;
    // Каждая выданная ссылка на файл записана в журнал аудита (находка S8). Имени файла в записи нет: в нём бывают личные данные.
    await writeAudit(tx, { action: 'attachment.downloaded_by_staff', objectType: 'attachment', objectId: attachmentId, orgId: row.orgId, diff: { ticketId: row.ticketId } });
    return { storageKey: row.storageKey, fileName: row.fileName, mime: row.mime };
  });
}
