import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { emitEventTx, enqueue, wakeAutomation, writeAudit } from '@/modules/hdc/api';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { refreshSla } from '../core/sla';
import { HdtError } from '../error';
import { ticketEvents, ticketMessages, tickets } from '../schema';

// Модуль hdt, слой api: сообщение клиента для перевода и определения благодарности (план M5b, задача 9; FR-AG-11,
// FR-TK-14, решение 24). Модулю hda отдаётся только текст одного публичного сообщения клиента: ни темы, ни описания,
// ни других сообщений, ни заметок (перечень 14.3).

const SYSTEM: SystemActor = { type: 'system', job: 'ai.thanks' };

export type ClientMessageForAi = { messageId: string; ticketId: string; orgId: string; authorId: string; body: string; source: string; isThanks: boolean };

/** Публичное сообщение клиента. Сообщение сотрудника, системы, помощника и заметка: null. */
export async function clientMessageForAi(actor: SystemActor | StaffActor, messageId: string): Promise<ClientMessageForAi | null> {
  if (actor.type !== 'system' && actor.type !== 'staff') throw new HdtError('forbidden');
  const id = z.uuid().safeParse(messageId);
  if (!id.success) return null;
  const [row] = await withActor(actor, (tx) =>
    tx
      .select({ messageId: ticketMessages.messageId, ticketId: ticketMessages.ticketId, orgId: ticketMessages.orgId, authorId: ticketMessages.authorId, body: ticketMessages.body, source: ticketMessages.source, isThanks: ticketMessages.isThanks })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.messageId, id.data), eq(ticketMessages.authorType, 'client'), eq(ticketMessages.isInternal, false)))
      .limit(1),
  );
  return row && row.authorId ? { ...row, authorId: row.authorId, source: row.source ?? 'portal' } : null;
}

/**
 * Клиент ответил в решённое обращение и код счёл ответ благодарностью (FR-TK-14): если AI-обработка организации
 * включена, задание ai.thanks уточнит это у модели. Модель может только открыть обращение заново.
 */
export async function thanksOnClientReply(ticketId: string): Promise<void> {
  try {
    const [last] = await withActor(SYSTEM, (tx) =>
      tx
        .select({ messageId: ticketMessages.messageId, orgId: ticketMessages.orgId, isThanks: ticketMessages.isThanks, authorType: ticketMessages.authorType })
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, ticketId))
        .orderBy(desc(ticketMessages.createdOn), desc(ticketMessages.messageId))
        .limit(1),
    );
    if (!last || last.authorType !== 'client' || !last.isThanks) return;
    const profile = await orgAiProfile(SYSTEM, { orgId: last.orgId, userIds: [] });
    if (!profile?.isAiEnabled) return;
    await enqueue('ai.thanks', { messageId: last.messageId });
  } catch (error) {
    // Уточнение необязательно: без него остаётся решение простых признаков.
    console.error(`Благодарность не отправлена на уточнение в обращении ${ticketId}: ${error instanceof Error ? error.message : 'ошибка'}`);
  }
}

/**
 * Модель ответила "не благодарность": обращение открывается заново (решённое переходит в "В работе"), в истории
 * событие статуса с причиной ai_thanks и идентификатором сообщения, запись журнала аудита, события для правил.
 * Сообщения не меняются (переписка только пополняется): из списка "Не открыли обращение" такое сообщение убирает
 * событие с его идентификатором. Обращение уже не решено или сообщение не благодарность: ничего, false.
 */
export async function reopenAfterAiThanks(actor: SystemActor, messageId: string): Promise<boolean> {
  if (actor.type !== 'system') throw new HdtError('forbidden');
  const id = z.uuid().parse(messageId);
  const done = await withActor(actor, async (tx) => {
    const [message] = await tx.select({ ticketId: ticketMessages.ticketId, isThanks: ticketMessages.isThanks }).from(ticketMessages).where(eq(ticketMessages.messageId, id)).limit(1);
    if (!message?.isThanks) return false;
    const [ticket] = await tx.select({ ticketId: tickets.ticketId, orgId: tickets.orgId, status: tickets.status }).from(tickets).where(eq(tickets.ticketId, message.ticketId)).limit(1).for('update');
    if (!ticket || ticket.status !== 'resolved') return false;
    const diff = { from: 'resolved', to: 'in_progress', reason: 'ai_thanks', messageId: id };
    await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'system', payload: diff });
    await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff });
    await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from: 'resolved', to: 'in_progress' } });
    await refreshSla(tx, ticket.ticketId, new Date(), { status: 'in_progress', lastClientMessageOn: sql`now()`, clientWaitingSince: sql`coalesce(${tickets.clientWaitingSince}, now())` });
    return true;
  });
  if (done) await wakeAutomation();
  return done;
}
