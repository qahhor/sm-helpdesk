import 'server-only';
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { type ClientActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { ATTACHABLE_SCAN_STATUSES, type Impact, PRIORITY_BY_IMPACT, TICKET_PAGE_SIZE, type TicketStatus, type TicketType, type Visibility } from '../pref';
import { attachments, ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';

// Модуль hdt, слой core: обращения. Операции с данными внутри withActor под ролью hub_app.
// Организация и автор берутся из актора; политики RLS и триггер t_hdt_tickets_client_guard страхуют.

export type NewTicket = {
  title: string;
  description: string;
  type: TicketType;
  impact: Impact;
  visibility: Visibility;
  moduleId?: string;
  relatedNumber?: number;
  attachmentIds: string[];
  locale: string;
};

/**
 * Обращение клиента одной транзакцией: строка обращения, прикреплённые загрузки, подписка автора,
 * событие создания и запись журнала аудита. Отменяют всё: чужая, уже прикреплённая или не прошедшая
 * проверку загрузка (file_unavailable) и невидимое связанное обращение (invalid_input).
 */
export async function createTicketTx(actor: ClientActor, input: NewTicket): Promise<{ ticketId: string; number: number }> {
  return withActor(actor, async (tx) => {
    let relatedTicketId: string | null = null;
    if (input.relatedNumber !== undefined) {
      const related = await tx.select({ ticketId: tickets.ticketId }).from(tickets).where(eq(tickets.number, input.relatedNumber)).limit(1);
      if (!related[0]) throw new HdtError('invalid_input');
      relatedTicketId = related[0].ticketId;
    }
    const priority = PRIORITY_BY_IMPACT[input.impact];
    const row = (
      await tx
        .insert(tickets)
        .values({
          orgId: actor.orgId,
          authorId: actor.userId,
          type: input.type,
          impact: input.impact,
          priority,
          visibility: input.visibility,
          title: input.title,
          description: input.description,
          locale: input.locale,
          moduleId: input.moduleId ?? null,
          relatedTicketId,
          source: 'portal',
        })
        .returning({ ticketId: tickets.ticketId, number: tickets.number })
    )[0] as { ticketId: string; number: number };
    if (input.attachmentIds.length > 0) {
      const attached = await tx
        .update(attachments)
        .set({ ticketId: row.ticketId })
        .where(
          and(
            inArray(attachments.attachmentId, input.attachmentIds),
            eq(attachments.uploaderId, actor.userId),
            isNull(attachments.ticketId),
            inArray(attachments.scanStatus, ATTACHABLE_SCAN_STATUSES),
          ),
        )
        .returning({ attachmentId: attachments.attachmentId });
      if (attached.length !== new Set(input.attachmentIds).size) throw new HdtError('file_unavailable');
    }
    await tx.insert(ticketWatchers).values({ orgId: actor.orgId, ticketId: row.ticketId, userId: actor.userId, source: 'author' });
    await tx.insert(ticketEvents).values({ orgId: actor.orgId, ticketId: row.ticketId, kind: 'created', actorType: 'client', actorId: actor.userId });
    await writeAudit(tx, { action: 'ticket.created', objectType: 'ticket', objectId: row.ticketId, orgId: actor.orgId, diff: { type: input.type, priority } });
    return row;
  });
}

// --- Чтение ---

export type ListFilters = {
  mineOnly: boolean;
  status?: TicketStatus;
  type?: TicketType;
  /** Номер и текст ищутся через "или": цифры могут быть и номером обращения, и частью описания. */
  number?: number;
  text?: string;
  /** Курсор: время изменения текстом базы (с микросекундами, Date их теряет) и идентификатор. */
  after?: { modifiedOn: string; ticketId: string };
};

export type ListedTicket = {
  ticketId: string;
  number: number;
  title: string;
  status: TicketStatus;
  type: TicketType;
  visibility: Visibility;
  authorId: string;
  modifiedOn: Date;
  modifiedOnText: string;
};

/** Экранирует знаки шаблона LIKE: поиск идёт по тексту как он есть. */
const likeText = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Обращения, видимые актору (политики RLS), новые изменения первыми, на одну строку больше страницы. */
export async function listTicketRows(actor: ClientActor, filters: ListFilters): Promise<ListedTicket[]> {
  const where: SQL[] = [];
  if (filters.mineOnly) where.push(eq(tickets.authorId, actor.userId));
  if (filters.status) where.push(eq(tickets.status, filters.status));
  if (filters.type) where.push(eq(tickets.type, filters.type));
  // Поиск: номер обращения или текст темы и описания. Цифры ищутся и как номер, и как текст (код ошибки, документ).
  const search: SQL[] = [];
  if (filters.number !== undefined) search.push(eq(tickets.number, filters.number));
  if (filters.text) search.push(ilike(tickets.title, likeText(filters.text)), ilike(tickets.description, likeText(filters.text)));
  if (search.length > 0) where.push(or(...search) as SQL);
  if (filters.after) where.push(sql`(${tickets.modifiedOn}, ${tickets.ticketId}) < (${filters.after.modifiedOn}::timestamptz, ${filters.after.ticketId}::uuid)`);
  return withActor(actor, (tx) =>
    tx
      .select({
        ticketId: tickets.ticketId,
        number: tickets.number,
        title: tickets.title,
        status: tickets.status,
        type: tickets.type,
        visibility: tickets.visibility,
        authorId: tickets.authorId,
        modifiedOn: tickets.modifiedOn,
        modifiedOnText: sql<string>`${tickets.modifiedOn}::text`,
      })
      .from(tickets)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(tickets.modifiedOn), desc(tickets.ticketId))
      .limit(TICKET_PAGE_SIZE + 1),
  );
}

/** Видно ли актору обращение с этим номером (политики RLS). Одна строка без сообщений и файлов. */
export async function ticketExists(actor: ClientActor, number: number): Promise<boolean> {
  const rows = await withActor(actor, (tx) => tx.select({ ticketId: tickets.ticketId }).from(tickets).where(eq(tickets.number, number)).limit(1));
  return rows.length > 0;
}

export type TicketRecord = typeof tickets.$inferSelect;
export type MessageRecord = Pick<typeof ticketMessages.$inferSelect, 'messageId' | 'authorId' | 'authorType' | 'body' | 'createdOn'>;
export type EventRecord = Pick<typeof ticketEvents.$inferSelect, 'kind' | 'actorType' | 'actorId' | 'payload' | 'createdOn'>;
export type AttachmentRecord = Pick<
  typeof attachments.$inferSelect,
  'attachmentId' | 'messageId' | 'uploaderId' | 'fileName' | 'mime' | 'size' | 'scanStatus' | 'scanSignature' | 'createdOn'
>;

/**
 * Обращение по номеру со всем, что видит актор: политики RLS не отдают внутренние заметки, события и
 * чужие непроверенные вложения. Невидимое и несуществующее обращение: пусто.
 */
export async function readTicket(
  actor: ClientActor,
  number: number,
): Promise<{ ticket: TicketRecord; messages: MessageRecord[]; events: EventRecord[]; attachments: AttachmentRecord[]; watching: boolean; relatedNumber: number | null } | null> {
  return withActor(actor, async (tx) => {
    const ticket = (await tx.select().from(tickets).where(eq(tickets.number, number)).limit(1))[0];
    if (!ticket) return null;
    const messages = await tx
      .select({
        messageId: ticketMessages.messageId,
        authorId: ticketMessages.authorId,
        authorType: ticketMessages.authorType,
        body: ticketMessages.body,
        createdOn: ticketMessages.createdOn,
      })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticket.ticketId))
      .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
    const events = await tx
      .select({ kind: ticketEvents.kind, actorType: ticketEvents.actorType, actorId: ticketEvents.actorId, payload: ticketEvents.payload, createdOn: ticketEvents.createdOn })
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
        createdOn: attachments.createdOn,
      })
      .from(attachments)
      .where(eq(attachments.ticketId, ticket.ticketId))
      .orderBy(asc(attachments.createdOn), asc(attachments.attachmentId));
    const watching =
      (await tx.select({ id: ticketWatchers.watcherId }).from(ticketWatchers).where(and(eq(ticketWatchers.ticketId, ticket.ticketId), eq(ticketWatchers.userId, actor.userId))).limit(1))
        .length > 0;
    const relatedNumber = ticket.relatedTicketId
      ? ((await tx.select({ number: tickets.number }).from(tickets).where(eq(tickets.ticketId, ticket.relatedTicketId)).limit(1))[0]?.number ?? null)
      : null;
    return { ticket, messages, events, attachments: files, watching, relatedNumber };
  });
}
