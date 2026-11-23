import 'server-only';
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type ClientActor, type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { ATTACHABLE_SCAN_STATUSES, type Impact, type Priority, PRIORITY_BY_IMPACT, TICKET_PAGE_SIZE, type TicketStatus, type TicketType, type Visibility } from '../pref';
import { attachments, ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';
import { finalMainNumberTx } from './merged-into';
import { timelineWindowTx } from './timeline';
import { refreshSla } from './sla';
import { notifyTicketTx, oncallP1Tx } from './notify';

// Модуль hdt, слой core: обращения. Операции с данными внутри withActor под ролью hub_app.
// Организация и автор берутся из актора; политики RLS и триггер t_hdt_tickets_client_guard страхуют.

/**
 * Второй слой изоляции (аудит 23.11.2026, находки P1 и S7): обращения организации клиента. Организация берётся из
 * актора. Политики RLS остаются первым слоем; условие в запросе даёт планировщику индекс по организации и держит
 * границу, если политика ослаблена ошибкой миграции.
 */
export function clientTicketScope(actor: ClientActor): SQL {
  return eq(tickets.orgId, actor.orgId);
}

/** Обращение организации клиента по номеру. */
export function clientTicketByNumber(actor: ClientActor, number: number): SQL {
  return and(clientTicketScope(actor), eq(tickets.number, number)) as SQL;
}

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
      const related = await tx.select({ ticketId: tickets.ticketId }).from(tickets).where(clientTicketByNumber(actor, input.relatedNumber)).limit(1);
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
          // P1 от клиента: отметка сообщения дежурным ставится вставкой, клиент колонку не обновляет (FR-SLA-07).
          oncallNotifiedOn: priority === 'p1' ? sql`now()` : null,
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
    await notifyTicketTx(tx, { ticketId: row.ticketId, kind: 'created', actorUserId: null });
    if (priority === 'p1') await oncallP1Tx(tx, row.ticketId, { alreadyMarked: true });
    return row;
  });
}

/**
 * Обращение от имени клиента (FR-AG-08): организация и автор выбраны сотрудником и уже проверены слоем api
 * (действующий участник организации). Источник staff, автор подписан, событие создания от сотрудника, журнал,
 * сроки от момента создания. Приоритет, выбранный сотрудником, сразу подтверждён.
 */
export async function createTicketForClientTx(
  actor: StaffActor,
  input: Omit<NewTicket, 'relatedNumber'> & { orgId: string; authorId: string; priority?: Priority },
): Promise<{ ticketId: string; number: number }> {
  return withActor(actor, async (tx) => {
    const priority = input.priority ?? PRIORITY_BY_IMPACT[input.impact];
    const [row] = await tx
      .insert(tickets)
      .values({
        orgId: input.orgId,
        authorId: input.authorId,
        type: input.type,
        impact: input.impact,
        priority,
        priorityConfirmed: input.priority !== undefined,
        visibility: input.visibility,
        title: input.title,
        description: input.description,
        locale: input.locale,
        moduleId: input.moduleId ?? null,
        source: 'staff',
      })
      .returning({ ticketId: tickets.ticketId, number: tickets.number });
    if (!row) throw new Error('hdt: обращение не создано');
    if (input.attachmentIds.length > 0) {
      const attached = await tx
        .update(attachments)
        .set({ ticketId: row.ticketId })
        .where(
          and(
            inArray(attachments.attachmentId, input.attachmentIds),
            eq(attachments.uploaderId, actor.userId),
            eq(attachments.orgId, input.orgId),
            isNull(attachments.ticketId),
            inArray(attachments.scanStatus, ATTACHABLE_SCAN_STATUSES),
          ),
        )
        .returning({ attachmentId: attachments.attachmentId });
      if (attached.length !== new Set(input.attachmentIds).size) throw new HdtError('file_unavailable');
    }
    await tx.insert(ticketWatchers).values({ orgId: input.orgId, ticketId: row.ticketId, userId: input.authorId, source: 'author' });
    await tx.insert(ticketEvents).values({ orgId: input.orgId, ticketId: row.ticketId, kind: 'created', actorType: 'staff', actorId: actor.userId });
    await writeAudit(tx, {
      action: 'ticket.created',
      objectType: 'ticket',
      objectId: row.ticketId,
      orgId: input.orgId,
      diff: { type: input.type, priority, source: 'staff', authorId: input.authorId },
    });
    await refreshSla(tx, row.ticketId, new Date());
    await notifyTicketTx(tx, { ticketId: row.ticketId, kind: 'created', actorUserId: actor.userId });
    await oncallP1Tx(tx, row.ticketId);
    return row;
  });
}

/**
 * Обращение из письма (FR-EM-01, FR-EM-10, решение 19 вехи M4) в транзакции разбора письма: тип question, влияние
 * minor, P3 без подтверждения, источник email. Автор и организация определены разбором по адресу и DMARC, не письмом.
 * Подписка автора, событие создания от клиента, журнал, сроки от момента создания.
 */
export async function createEmailTicketTx(
  tx: Tx,
  input: { orgId: string; authorId: string; title: string; body: string; locale: string; visibility: Visibility; senderUnconfirmed: boolean },
): Promise<{ ticketId: string; number: number }> {
  const [row] = await tx
    .insert(tickets)
    .values({
      orgId: input.orgId,
      authorId: input.authorId,
      type: 'question',
      impact: 'minor',
      priority: PRIORITY_BY_IMPACT.minor,
      visibility: input.visibility,
      title: input.title,
      description: input.body,
      locale: input.locale,
      source: 'email',
      senderUnconfirmed: input.senderUnconfirmed,
    })
    .returning({ ticketId: tickets.ticketId, number: tickets.number });
  if (!row) throw new Error('hdt: обращение из письма не создано');
  await tx.insert(ticketWatchers).values({ orgId: input.orgId, ticketId: row.ticketId, userId: input.authorId, source: 'author' });
  await tx.insert(ticketEvents).values({ orgId: input.orgId, ticketId: row.ticketId, kind: 'created', actorType: 'client', actorId: input.authorId });
  await writeAudit(tx, {
    action: 'ticket.created',
    objectType: 'ticket',
    objectId: row.ticketId,
    orgId: input.orgId,
    diff: { type: 'question', priority: PRIORITY_BY_IMPACT.minor, source: 'email', authorId: input.authorId },
  });
  await refreshSla(tx, row.ticketId, new Date());
  return row;
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
  const where: SQL[] = [clientTicketScope(actor)];
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
      .where(and(...where))
      .orderBy(desc(tickets.modifiedOn), desc(tickets.ticketId))
      .limit(TICKET_PAGE_SIZE + 1),
  );
}

/** Видно ли актору обращение с этим номером (политики RLS). Одна строка без сообщений и файлов. */
export async function ticketExists(actor: ClientActor, number: number): Promise<boolean> {
  const rows = await withActor(actor, (tx) => tx.select({ ticketId: tickets.ticketId }).from(tickets).where(clientTicketByNumber(actor, number)).limit(1));
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
  limit: number,
): Promise<{ ticket: TicketRecord; messages: MessageRecord[]; events: EventRecord[]; attachments: AttachmentRecord[]; hasEarlier: boolean; watching: boolean; relatedNumber: number | null; mergedIntoNumber: number | null } | null> {
  return withActor(actor, async (tx) => {
    const ticket = (await tx.select().from(tickets).where(clientTicketByNumber(actor, number)).limit(1))[0];
    if (!ticket) return null;
    // Последние записи истории, а не вся переписка (аудит 23.11.2026, находка P11). Окно считается под политиками
    // клиента: внутренние заметки и события в него не входят.
    const window = await timelineWindowTx(tx, ticket.ticketId, limit);
    const messages = window.messageIds.length === 0 ? [] : await tx
      .select({
        messageId: ticketMessages.messageId,
        authorId: ticketMessages.authorId,
        authorType: ticketMessages.authorType,
        body: ticketMessages.body,
        createdOn: ticketMessages.createdOn,
      })
      .from(ticketMessages)
      .where(inArray(ticketMessages.messageId, window.messageIds))
      .orderBy(asc(ticketMessages.createdOn), asc(ticketMessages.messageId));
    const events = window.eventIds.length === 0 ? [] : await tx
      .select({ kind: ticketEvents.kind, actorType: ticketEvents.actorType, actorId: ticketEvents.actorId, payload: ticketEvents.payload, createdOn: ticketEvents.createdOn })
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
    // Номер основного только если основное видно этому клиенту (решение 4 плана M3): запрос идёт под его политикой.
    const mergedIntoNumber = await finalMainNumberTx(tx, ticket.mergedIntoId);
    return { ticket, messages, events, attachments: files, hasEarlier: window.hasEarlier, watching, relatedNumber, mergedIntoNumber };
  });
}
