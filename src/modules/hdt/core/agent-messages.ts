import 'server-only';
import { type AnyColumn, and, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { HdtError } from '../error';
import { ATTACHABLE_SCAN_STATUSES, DEVELOPMENT_ROLES, type PresenceMode, PRESENCE_TTL_SEC, type TicketStatus } from '../pref';
import { attachments, mentions, replyDrafts, ticketEvents, ticketMessages, ticketPresence, tickets } from '../schema';
import { findMentions } from '../util';
import { assertCanWrite, changeAssigneeTx, changeStatusTx, lockAgentTicket, markPickedUpTx } from './agent-actions';
import { notifyTicketTx } from './notify';

// Модуль hdt, слой core: ответ клиенту и внутренняя заметка сотрудника, черновик, присутствие
// (FR-AG-03, FR-AG-12, FR-AG-21, FR-SLA-04, UX-A-05..07; план M3, задача 8, решения 6 и 10).

/** Что изменили другие после того, как агент открыл обращение (FR-AG-12, UX-A-06). */
export type ChangeSummary = { newMessages: number; statusChanged: boolean; assigneeChanged: boolean };

export type StaffMessage = {
  number: number;
  body: string;
  internal: boolean;
  attachmentIds: string[];
  waitForClient: boolean;
  seenVersion: Date;
};

/** Отказ несёт версию: последнюю запись переписки и истории. С ней агент может отправить, уже зная, что изменилось. */
export type PostResult = { ok: true; ticketId: string } | { ok: false; changed: ChangeSummary; version: string };

// Время в браузере передаётся с точностью до миллисекунды, в базе до микросекунды: сравнение по миллисекундам.
const after = (column: AnyColumn, seen: Date) => gt(sql`date_trunc('milliseconds', ${column})`, seen);

/** Сообщения, смена статуса и исполнителя от других людей после seen. Свои действия изменением не считаются. */
async function changesSinceTx(tx: Tx, ticketId: string, seen: Date, me: string): Promise<ChangeSummary> {
  const [messages] = await tx
    .select({ n: count() })
    .from(ticketMessages)
    .where(and(eq(ticketMessages.ticketId, ticketId), after(ticketMessages.createdOn, seen), sql`${ticketMessages.authorId} is distinct from ${me}::uuid`));
  const kinds = await tx
    .selectDistinct({ kind: ticketEvents.kind })
    .from(ticketEvents)
    .where(
      and(
        eq(ticketEvents.ticketId, ticketId),
        inArray(ticketEvents.kind, ['status', 'assignee']),
        after(ticketEvents.createdOn, seen),
        sql`${ticketEvents.actorId} is distinct from ${me}::uuid`,
      ),
    );
  return {
    newMessages: messages?.n ?? 0,
    statusChanged: kinds.some((k) => k.kind === 'status'),
    assigneeChanged: kinds.some((k) => k.kind === 'assignee'),
  };
}

const hasChanges = (c: ChangeSummary) => c.newMessages > 0 || c.statusChanged || c.assigneeChanged;

/** Время последней записи обращения, переписки и истории: та же версия, что видит страница. */
async function latestEntryTx(tx: Tx, ticketId: string): Promise<string> {
  const result = await tx.execute<{ latest: Date | string }>(sql`
    select greatest(
      (select created_on from hdt_tickets where ticket_id = ${ticketId}),
      (select max(created_on) from hdt_ticket_messages where ticket_id = ${ticketId}),
      (select max(created_on) from hdt_ticket_events where ticket_id = ${ticketId})) as latest`);
  return new Date(result.rows[0]?.latest ?? 0).toISOString();
}

/**
 * Ответ клиенту или заметка одной транзакцией. Если обращение изменили другие после seenVersion, ничего не
 * сохраняется и возвращается сводка. Ответ клиенту: первый останавливает срок первого ответа, снимает "клиент ждёт",
 * новое обращение берёт ответивший (если исполнителя нет) и ставит "В работе"; флажок ставит "Ждём вашего ответа".
 * Заметка сроки не трогает, её файлы внутренние, "@имя" создаёт упоминание. Черновик автора удаляется.
 */
export async function postStaffMessageTx(
  actor: StaffActor,
  input: StaffMessage,
  people: { myName: string; mentionable: readonly { userId: string; name: string }[] },
): Promise<PostResult> {
  assertCanWrite(actor);
  return withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, input.number);
    // В объединённом клиенту не отвечают: он продолжает в основном (решение 4). Заметка остаётся можно.
    if (ticket.mergedIntoId && !input.internal) throw new HdtError('merged');
    const changed = await changesSinceTx(tx, ticket.ticketId, input.seenVersion, actor.userId);
    if (hasChanges(changed)) return { ok: false, changed, version: await latestEntryTx(tx, ticket.ticketId) };
    const [message] = await tx
      .insert(ticketMessages)
      .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorId: actor.userId, authorType: 'staff', body: input.body, isInternal: input.internal })
      .returning({ messageId: ticketMessages.messageId });
    if (!message) throw new Error('hdt: сообщение не сохранено');
    if (input.attachmentIds.length > 0) {
      const attached = await tx
        .update(attachments)
        .set({ ticketId: ticket.ticketId, messageId: message.messageId, isInternal: input.internal })
        .where(
          and(
            inArray(attachments.attachmentId, input.attachmentIds),
            eq(attachments.uploaderId, actor.userId),
            eq(attachments.orgId, ticket.orgId),
            isNull(attachments.ticketId),
            inArray(attachments.scanStatus, ATTACHABLE_SCAN_STATUSES),
          ),
        )
        .returning({ attachmentId: attachments.attachmentId });
      if (attached.length !== input.attachmentIds.length) throw new HdtError('file_unavailable');
    }
    if (input.internal) {
      const mentioned = findMentions(input.body, people.mentionable).filter((userId) => userId !== actor.userId);
      if (mentioned.length > 0) {
        await tx.insert(mentions).values(mentioned.map((userId) => ({ messageId: message.messageId, userId })));
        await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'mention', actorUserId: actor.userId, mentioned, authorName: people.myName });
      }
    } else {
      await tx
        .update(tickets)
        .set({ firstRespondedOn: sql`coalesce(${tickets.firstRespondedOn}, now())`, clientWaitingSince: null })
        .where(eq(tickets.ticketId, ticket.ticketId));
      // Ответ берёт новое обращение на своей линии (решение 6): ответ первой линии на переданное второй не забирает его.
      const ownLine = ticket.queue === 'l1' || (DEVELOPMENT_ROLES as readonly string[]).includes(actor.staffRole);
      if (!ticket.assigneeId && ticket.status === 'new' && ownLine) await changeAssigneeTx(tx, actor, ticket, actor.userId, people.myName);
      const target: TicketStatus | null = input.waitForClient ? 'waiting_customer' : ticket.status === 'new' ? 'in_progress' : null;
      if (target && target !== ticket.status) await changeStatusTx(tx, actor, ticket, target);
      await markPickedUpTx(tx, actor, ticket);
      // Одно письмо об ответе, даже если тем же действием поставлено "Ждём вашего ответа" (решение 6).
      await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'staff_reply', actorUserId: actor.userId, messageId: message.messageId });
    }
    await tx.delete(replyDrafts).where(and(eq(replyDrafts.ticketId, ticket.ticketId), eq(replyDrafts.userId, actor.userId)));
    return { ok: true, ticketId: ticket.ticketId };
  });
}

async function ticketIdOf(tx: Tx, number: number): Promise<string> {
  const [row] = await tx.select({ ticketId: tickets.ticketId }).from(tickets).where(eq(tickets.number, number)).limit(1);
  if (!row) throw new HdtError('not_found');
  return row.ticketId;
}

/** Черновик сотрудника (FR-AG-21): пустой текст удаляет черновик. */
export async function saveDraftTx(actor: StaffActor, number: number, body: string, internal: boolean): Promise<void> {
  assertCanWrite(actor);
  await withActor(actor, async (tx) => {
    const ticketId = await ticketIdOf(tx, number);
    // Отложенное сохранение опоздало и принесло уже отправленный текст: черновик не воскрешается (FR-AG-21).
    const [last] = await tx
      .select({ body: ticketMessages.body })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.authorId, actor.userId)))
      .orderBy(desc(ticketMessages.createdOn))
      .limit(1);
    if (body.length === 0 || last?.body === body) {
      await tx.delete(replyDrafts).where(and(eq(replyDrafts.ticketId, ticketId), eq(replyDrafts.userId, actor.userId)));
      return;
    }
    await tx
      .insert(replyDrafts)
      .values({ ticketId, userId: actor.userId, body, isInternal: internal })
      .onConflictDoUpdate({ target: [replyDrafts.ticketId, replyDrafts.userId], set: { body, isInternal: internal } });
  });
}

export async function loadDraftTx(actor: StaffActor, number: number): Promise<{ body: string; internal: boolean; savedOn: Date } | null> {
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ body: replyDrafts.body, internal: replyDrafts.isInternal, savedOn: replyDrafts.modifiedOn })
      .from(replyDrafts)
      .innerJoin(tickets, eq(tickets.ticketId, replyDrafts.ticketId))
      .where(and(eq(tickets.number, number), eq(replyDrafts.userId, actor.userId)));
    return row ?? null;
  });
}

/** Отметка "открыл" или "печатает" на 60 секунд (решение 10). Отмечаться может любой сотрудник, в том числе product. */
export async function touchPresenceTx(actor: StaffActor, number: number, mode: PresenceMode): Promise<void> {
  await withActor(actor, async (tx) => {
    const ticketId = await ticketIdOf(tx, number);
    const expiresOn = sql`now() + make_interval(secs => ${PRESENCE_TTL_SEC})`;
    await tx
      .insert(ticketPresence)
      .values({ ticketId, userId: actor.userId, mode, expiresOn })
      .onConflictDoUpdate({ target: [ticketPresence.ticketId, ticketPresence.userId], set: { mode, expiresOn } });
  });
}

/** Другие сотрудники с действующей отметкой на этом обращении. */
export async function listPresenceTx(actor: StaffActor, number: number): Promise<{ userId: string; mode: PresenceMode }[]> {
  return withActor(actor, (tx) =>
    tx
      .select({ userId: ticketPresence.userId, mode: ticketPresence.mode })
      .from(ticketPresence)
      .innerJoin(tickets, eq(tickets.ticketId, ticketPresence.ticketId))
      .where(and(eq(tickets.number, number), ne(ticketPresence.userId, actor.userId), gt(ticketPresence.expiresOn, sql`now()`)))
      .orderBy(ticketPresence.createdOn),
  );
}
