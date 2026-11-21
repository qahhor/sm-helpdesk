import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type ClientActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdtError } from '../error';
import { type Impact, PRIORITY_BY_IMPACT, type TicketType, type Visibility } from '../pref';
import { attachments, ticketEvents, tickets, ticketWatchers } from '../schema';

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
 * событие создания и запись журнала аудита. Чужая или уже прикреплённая загрузка и невидимое
 * связанное обращение отменяют всё: invalid_input.
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
        .where(and(inArray(attachments.attachmentId, input.attachmentIds), eq(attachments.uploaderId, actor.userId), isNull(attachments.ticketId)))
        .returning({ attachmentId: attachments.attachmentId });
      if (attached.length !== new Set(input.attachmentIds).size) throw new HdtError('invalid_input');
    }
    await tx.insert(ticketWatchers).values({ orgId: actor.orgId, ticketId: row.ticketId, userId: actor.userId, source: 'author' });
    await tx.insert(ticketEvents).values({ orgId: actor.orgId, ticketId: row.ticketId, kind: 'created', actorType: 'client', actorId: actor.userId });
    await writeAudit(tx, { action: 'ticket.created', objectType: 'ticket', objectId: row.ticketId, orgId: actor.orgId, diff: { type: input.type, priority } });
    return row;
  });
}
