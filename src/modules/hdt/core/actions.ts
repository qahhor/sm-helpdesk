import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { readSetting, writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { ATTACHABLE_SCAN_STATUSES, canTransition, type CsatReason, REOPEN_DAYS_DEFAULT, REOPEN_DAYS_SETTING, type TicketStatus, type Visibility } from '../pref';
import { attachments, ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';
import { isThanks } from './thanks';
import { notifyTicketTx } from './notify';

// Модуль hdt, слой core: действия клиента над обращением (FR-TK-08..12). Каждое действие одной
// транзакцией: обращение блокируется (одновременное второе нажатие видит уже новый статус), меняется
// фиксированный набор колонок, пишутся событие истории и запись журнала аудита.

type Locked = {
  ticketId: string;
  orgId: string;
  authorId: string;
  status: TicketStatus;
  visibility: Visibility;
  closedOn: Date | null;
  csatScore: number | null;
  mergedIntoId: string | null;
};

/** Видимое актору обращение по номеру с блокировкой строки. Невидимое и несуществующее: not_found. */
async function lockTicket(tx: Tx, number: number): Promise<Locked> {
  const row = (
    await tx
      .select({
        ticketId: tickets.ticketId,
        orgId: tickets.orgId,
        authorId: tickets.authorId,
        status: tickets.status,
        visibility: tickets.visibility,
        closedOn: tickets.closedOn,
        csatScore: tickets.csatScore,
        mergedIntoId: tickets.mergedIntoId,
      })
      .from(tickets)
      .where(eq(tickets.number, number))
      .limit(1)
      .for('update')
  )[0];
  if (!row) throw new HdtError('not_found');
  return row;
}

/** Переход статуса по таблице раздела 7.2 с событием и записью журнала. */
async function changeStatus(tx: Tx, actor: ClientActor, ticket: Locked, to: TicketStatus, extra: Partial<typeof tickets.$inferInsert> = {}): Promise<void> {
  if (!canTransition(ticket.status, to)) throw new HdtError('transition_refused');
  const changed = await tx
    .update(tickets)
    .set({ status: to, ...extra })
    .where(and(eq(tickets.ticketId, ticket.ticketId), eq(tickets.status, ticket.status)))
    .returning({ ticketId: tickets.ticketId });
  if (changed.length === 0) throw new HdtError('transition_refused');
  const diff = { from: ticket.status, to };
  await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'client', actorId: actor.userId, payload: diff });
  await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff });
}

/** Сообщение клиента с прикреплением его загрузок. Чужая или уже прикреплённая загрузка: invalid_input. */
async function addClientMessage(tx: Tx, actor: ClientActor, ticket: Locked, body: string, attachmentIds: string[] = [], isThanks = false): Promise<void> {
  const message = (
    await tx
      .insert(ticketMessages)
      .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorId: actor.userId, authorType: 'client', body, isThanks })
      .returning({ messageId: ticketMessages.messageId })
  )[0] as { messageId: string };
  if (attachmentIds.length > 0) {
    const attached = await tx
      .update(attachments)
      .set({ ticketId: ticket.ticketId, messageId: message.messageId })
      .where(
        and(
          inArray(attachments.attachmentId, attachmentIds),
          eq(attachments.uploaderId, actor.userId),
          isNull(attachments.ticketId),
          inArray(attachments.scanStatus, ATTACHABLE_SCAN_STATUSES),
        ),
      )
      .returning({ attachmentId: attachments.attachmentId });
    if (attached.length !== attachmentIds.length) throw new HdtError('file_unavailable');
  }
}

/**
 * Ответ клиента (FR-TK-08). "Ждём вашего ответа" и "Решено" переходят в "В работе", кроме благодарности на
 * решённое (FR-TK-14, решение 0026, пункт 4). В закрытое обращение ответить нельзя: его открывают заново.
 */
export async function replyTx(actor: ClientActor, number: number, body: string, attachmentIds: string[]): Promise<string> {
  return withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    if (ticket.status === 'closed') throw new HdtError('transition_refused');
    // Благодарность на решённое (FR-TK-14, решение 15): сообщение сохраняется, обращение остаётся решённым и не
    // считается ждущим ответа. Файл в сообщении это уже не просто "спасибо": открывается заново.
    if (ticket.status === 'resolved' && attachmentIds.length === 0 && isThanks(body)) {
      await addClientMessage(tx, actor, ticket, body, [], true);
      await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: actor.userId });
      return ticket.ticketId;
    }
    await addClientMessage(tx, actor, ticket, body, attachmentIds);
    if (ticket.status === 'waiting_customer' || ticket.status === 'resolved')
      await changeStatus(tx, actor, ticket, 'in_progress', { lastClientMessageOn: new Date() });
    else await tx.update(tickets).set({ lastClientMessageOn: new Date() }).where(eq(tickets.ticketId, ticket.ticketId));
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: actor.userId });
    return ticket.ticketId;
  });
}

/** Срок повторного открытия, дней: настройка tickets.reopen_days, иначе 14 (FR-TK-12). */
export async function reopenDays(): Promise<number> {
  const value = await readSetting(REOPEN_DAYS_SETTING);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365 ? value : REOPEN_DAYS_DEFAULT;
}

/** "Решение подошло": resolved → closed (FR-TK-10). */
export async function confirmTx(actor: ClientActor, number: number): Promise<void> {
  await withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    // Закрыть чужое обращение подтверждением может только администратор клиента (решение 0026, пункт 21).
    if (ticket.authorId !== actor.userId && actor.orgRole !== 'client_admin') throw new HdtError('forbidden');
    if (ticket.status !== 'resolved') throw new HdtError('transition_refused');
    await changeStatus(tx, actor, ticket, 'closed', { closedOn: new Date() });
  });
}

/** Открыть заново: решённое всегда, закрытое в пределах срока (FR-TK-12). Необязательный текст становится сообщением. */
export async function reopenTx(actor: ClientActor, number: number, reopenDays: number, body?: string): Promise<string> {
  return withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    // Объединённое закрыто навсегда: клиент продолжает в основном (решение 4 плана M3).
    if (ticket.mergedIntoId) throw new HdtError('merged');
    if (ticket.status === 'closed') {
      const expired = !ticket.closedOn || Date.now() - ticket.closedOn.getTime() > reopenDays * 86_400_000;
      if (expired) throw new HdtError('reopen_expired');
    } else if (ticket.status !== 'resolved') throw new HdtError('transition_refused');
    if (body) await addClientMessage(tx, actor, ticket, body);
    await changeStatus(tx, actor, ticket, 'in_progress', body ? { lastClientMessageOn: new Date() } : {});
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: actor.userId });
    return ticket.ticketId;
  });
}

/** Оценка закрытого обращения, один раз (FR-TK-11). */
export async function rateTx(actor: ClientActor, number: number, rating: { score: number; reason?: CsatReason; comment?: string }): Promise<void> {
  await withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    // Оценка одна и отражает опыт автора: коллега не ставит её за него (решение 0026, пункт 21).
    if (ticket.authorId !== actor.userId) throw new HdtError('forbidden');
    if (ticket.status !== 'closed') throw new HdtError('transition_refused');
    if (ticket.csatScore !== null) throw new HdtError('already_rated');
    await tx
      .update(tickets)
      .set({ csatScore: rating.score, csatReason: rating.reason ?? null, csatComment: rating.comment ?? null })
      .where(eq(tickets.ticketId, ticket.ticketId));
    await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'rated', actorType: 'client', actorId: actor.userId, payload: { score: rating.score } });
  });
}

/** Видимость (FR-TK-04): меняют автор и администратор клиента. */
export async function visibilityTx(actor: ClientActor, number: number, visibility: Visibility): Promise<void> {
  const ticketId = await withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    if (ticket.authorId !== actor.userId && actor.orgRole !== 'client_admin') throw new HdtError('forbidden');
    if (ticket.visibility === visibility) return ticket.ticketId;
    await tx.update(tickets).set({ visibility }).where(eq(tickets.ticketId, ticket.ticketId));
    const diff = { from: ticket.visibility, to: visibility };
    await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'visibility', actorType: 'client', actorId: actor.userId, payload: diff });
    await writeAudit(tx, { action: 'ticket.visibility_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff });
    return ticket.ticketId;
  });
  // И при неизменной видимости: так повторное "Только я" чинит прошлую попытку, где снятие подписок сорвалось.
  if (visibility === 'private') await dropColleagueWatchers(ticketId, actor.ip ?? null);
}

/**
 * Обращение стало личным: подписки коллег снимаются (решение 17 плана M2), автор и сотрудники остаются.
 * Чужие строки подписок клиент удалить не может (политика RLS), поэтому снимает фоновая роль, и только пока
 * обращение действительно личное. Повторный вызов безопасен. Видимость к этому моменту уже сменена, поэтому сбой
 * не превращает успешное действие в ошибку: он пишется в журнал процесса, а следующее "Только я" снимает остаток.
 * Коллега личное обращение и так не видит (RLS), оставшаяся строка влияет только на уведомления (решение 0026, пункт 25).
 */
async function dropColleagueWatchers(ticketId: string, ip: string | null): Promise<void> {
  const system: SystemActor = { type: 'system', job: 'ticket.visibility', ip };
  try {
    await withActor(system, (tx) =>
      tx
        .delete(ticketWatchers)
        .where(
          and(
            eq(ticketWatchers.ticketId, ticketId),
            eq(ticketWatchers.source, 'manual'),
            sql`exists (select 1 from hdt_tickets t where t.ticket_id = ${ticketWatchers.ticketId} and t.visibility = 'private')`,
          ),
        ),
    );
  } catch (error) {
    console.error(`Подписки коллег на личное обращение ${ticketId} не сняты: ${error instanceof Error ? error.message : 'ошибка'}`);
  }
}

/** Подписка на обращение организации (FR-TK-09). Повторная подписка ничего не меняет. */
export async function watchTx(actor: ClientActor, number: number): Promise<void> {
  await withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    if (ticket.visibility !== 'org' || ticket.authorId === actor.userId) throw new HdtError('forbidden');
    await tx.insert(ticketWatchers).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, userId: actor.userId, source: 'manual' }).onConflictDoNothing();
  });
}

/** Отписка. Автор подписан всегда. */
export async function unwatchTx(actor: ClientActor, number: number): Promise<void> {
  await withActor(actor, async (tx) => {
    const ticket = await lockTicket(tx, number);
    if (ticket.authorId === actor.userId) throw new HdtError('forbidden');
    await tx.delete(ticketWatchers).where(and(eq(ticketWatchers.ticketId, ticket.ticketId), eq(ticketWatchers.userId, actor.userId)));
  });
}
