import 'server-only';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { emitEventTx, writeAudit } from '@/modules/hdc/api';
import { blockSenderTx } from '@/modules/hdn/api/inbound';
import { SERVICE_ORG_ID } from '@/modules/hdu/api/guests';
import { HdtError } from '../error';
import { attachments, ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';
import { lockAgentTicket } from './agent-actions';

// Модуль hdt, слой core: очередь "Неопознанные" (FR-EM-04, решения 12-14 вехи M4). Письма с неизвестных адресов лежат
// в служебной организации. Сотрудник привязывает обращение к организации клиента, закрывает как "Это не клиент" или
// "Спам". Обращения гостя переходят пользователю, когда тот доказал владение адресом (hdu_guest_merges).

/** Строк на странице очереди. */
export const UNIDENTIFIED_PAGE_SIZE = 50;

export type UnidentifiedRow = { ticketId: string; number: number; title: string; authorId: string; createdOn: Date };

/** Открытые обращения служебной организации, новые первыми, и их число. */
export async function unidentifiedRowsTx(actor: StaffActor, page: number): Promise<{ rows: UnidentifiedRow[]; count: number }> {
  return withActor(actor, async (tx) => {
    const open = and(eq(tickets.orgId, SERVICE_ORG_ID), ne(tickets.status, 'closed'));
    const rows = await tx
      .select({ ticketId: tickets.ticketId, number: tickets.number, title: tickets.title, authorId: tickets.authorId, createdOn: tickets.createdOn })
      .from(tickets)
      .where(open)
      .orderBy(desc(tickets.createdOn), desc(tickets.ticketId))
      .limit(UNIDENTIFIED_PAGE_SIZE + 1)
      .offset((page - 1) * UNIDENTIFIED_PAGE_SIZE);
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(tickets).where(open);
    return { rows, count: counted?.n ?? 0 };
  });
}

/** Число открытых обращений в "Неопознанных": для ссылки в очередях. */
export async function unidentifiedCountTx(actor: StaffActor): Promise<number> {
  const rows = await withActor(actor, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(tickets).where(and(eq(tickets.orgId, SERVICE_ORG_ID), ne(tickets.status, 'closed'))),
  );
  return rows[0]?.n ?? 0;
}

/**
 * Привязка (решение 13): обращение служебной организации переходит в организацию клиента с видимостью "организация".
 * Сообщения, события, подписки и вложения переходят каскадом внешних ключей. Событие bound и запись журнала.
 * Организацию проверяет слой api (действующая организация клиента).
 */
export async function bindTicketTx(actor: StaffActor, number: number, orgId: string): Promise<{ ticketId: string; authorId: string; description: string; moduleId: string | null }> {
  return withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.orgId !== SERVICE_ORG_ID || ticket.status === 'closed') throw new HdtError('transition_refused');
    const [row] = await tx
      .update(tickets)
      .set({ orgId, visibility: 'org' })
      .where(and(eq(tickets.ticketId, ticket.ticketId), eq(tickets.orgId, SERVICE_ORG_ID)))
      .returning({ authorId: tickets.authorId, description: tickets.description, moduleId: tickets.moduleId });
    if (!row) throw new HdtError('transition_refused');
    await tx.insert(ticketEvents).values({ orgId, ticketId: ticket.ticketId, kind: 'bound', actorType: 'staff', actorId: actor.userId, payload: { orgId }, isInternal: true });
    await writeAudit(tx, { action: 'ticket.bound', objectType: 'ticket', objectId: ticket.ticketId, orgId, diff: { from: SERVICE_ORG_ID, to: orgId } });
    return { ticketId: ticket.ticketId, authorId: row.authorId, description: row.description, moduleId: row.moduleId };
  });
}

/**
 * "Это не клиент" и "Спам" (решение 14): обращение служебной организации закрывается из любого статуса без письма,
 * событие с причиной и запись журнала. "Спам" к тому же вносит адрес в список отклонённых: следующие письма с него
 * сохраняются без обращения и без ответа.
 */
export async function closeUnidentifiedTx(actor: StaffActor, number: number, reason: 'not_client' | 'spam', senderAddress: () => Promise<string | null>): Promise<void> {
  const address = reason === 'spam' ? await senderAddress() : null;
  await withActor(actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    if (ticket.orgId !== SERVICE_ORG_ID || ticket.status === 'closed') throw new HdtError('transition_refused');
    await tx
      .update(tickets)
      .set({ status: 'closed', closedOn: sql`now()` })
      .where(and(eq(tickets.ticketId, ticket.ticketId), eq(tickets.status, ticket.status)));
    const payload = { from: ticket.status, to: 'closed', reason };
    await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'staff', actorId: actor.userId, payload });
    await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: payload });
    await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from: ticket.status, to: 'closed' } });
    if (address) {
      await blockSenderTx(tx, address, actor.userId);
      await writeAudit(tx, { action: 'sender.blocked', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId });
    }
  });
}

/** Автор обращения и организация: для приглашения отправителя. */
export async function ticketAuthorTx(actor: StaffActor, number: number): Promise<{ ticketId: string; orgId: string; authorId: string } | null> {
  const rows = await withActor(actor, (tx) =>
    tx.select({ ticketId: tickets.ticketId, orgId: tickets.orgId, authorId: tickets.authorId }).from(tickets).where(eq(tickets.number, number)).limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Обращения, сообщения, вложения и подписки гостя переходят пользователю (решение 13). Повтор безопасен: строк гостя
 * уже нет. Подписка пользователя на то же обращение остаётся одна. События истории остаются за гостем: это тот же
 * человек под именем из письма, а события неизменяемы.
 */
export async function moveGuestTx(actor: SystemActor, guestUserId: string, userId: string): Promise<void> {
  await withActor(actor, async (tx) => {
    // Обращения из писем без проверки DMARC: отметка "Отправитель не подтверждён" остаётся и после перехода, сотрудник
    // видит, что текст пришёл не подтверждённым письмом (итоговая проверка M4, замечание I5).
    const moved = await tx
      .update(tickets)
      .set({ authorId: userId, senderUnconfirmed: true })
      .where(eq(tickets.authorId, guestUserId))
      .returning({ ticketId: tickets.ticketId, orgId: tickets.orgId });
    for (const ticket of moved)
      await writeAudit(tx, { action: 'ticket.author_moved', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: { from: guestUserId, to: userId } });
    await tx.update(ticketMessages).set({ authorId: userId }).where(eq(ticketMessages.authorId, guestUserId));
    await tx.update(attachments).set({ uploaderId: userId }).where(eq(attachments.uploaderId, guestUserId));
    // Подписки неизменяемы (у роли портала нет права UPDATE): подписка гостя удаляется, у пользователя появляется своя.
    const watched = await tx.delete(ticketWatchers).where(eq(ticketWatchers.userId, guestUserId)).returning({
      orgId: ticketWatchers.orgId,
      ticketId: ticketWatchers.ticketId,
      source: ticketWatchers.source,
    });
    for (const row of watched) await tx.insert(ticketWatchers).values({ ...row, userId }).onConflictDoNothing();
  });
}

/** Обращений из писем с неизвестных адресов (очередь "Неопознанные"), созданных с указанного времени. */
export async function unidentifiedSinceTx(actor: SystemActor, since: Date): Promise<number> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(and(eq(tickets.orgId, SERVICE_ORG_ID), eq(tickets.source, 'email'), gt(tickets.createdOn, since))),
  );
  return rows[0]?.n ?? 0;
}
