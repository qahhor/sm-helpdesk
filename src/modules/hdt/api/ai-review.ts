import 'server-only';
import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdu/api';
import { HdtError } from '../error';
import { ticketMessages, tickets } from '../schema';

// Модуль hdt, слой api: данные обращений для разбора ответов помощника (план M5b, задача 8; FR-AI-16). Только
// сотрудники; модуль hda по ним находит строку журнала вызова и показывает список разбора.

function requireStaff(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff') throw new HdtError('forbidden');
}

export type AiMessageRef = { messageId: string; ticketId: string; orgId: string; number: number; createdOn: Date };

/** Сообщение помощника с ответом решением или вопросом. Иное сообщение (клиента, передача, подтверждение): null. */
export async function aiAnswerMessage(ctx: StaffContext, messageId: string): Promise<AiMessageRef | null> {
  requireStaff(ctx);
  const id = z.uuid().safeParse(messageId);
  if (!id.success) return null;
  const [row] = await withActor(ctx.actor, (tx) =>
    tx
      .select({ messageId: ticketMessages.messageId, ticketId: ticketMessages.ticketId, orgId: ticketMessages.orgId, number: tickets.number, createdOn: ticketMessages.createdOn })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.ticketId, ticketMessages.ticketId))
      .where(and(eq(ticketMessages.messageId, id.data), eq(ticketMessages.authorType, 'ai'), sql`${ticketMessages.aiPayload} ->> 'kind' in ('answer', 'clarify')`))
      .limit(1),
  );
  return row ?? null;
}

/** Номер и оценка обращений по идентификаторам: строки списка разбора. */
export async function ticketsForAiReview(ctx: StaffContext, ticketIds: readonly string[]): Promise<Map<string, { number: number; rating: number | null }>> {
  requireStaff(ctx);
  if (ticketIds.length === 0) return new Map();
  const rows = await withActor(ctx.actor, (tx) =>
    tx.select({ ticketId: tickets.ticketId, number: tickets.number, rating: tickets.csatScore }).from(tickets).where(inArray(tickets.ticketId, [...new Set(ticketIds)])),
  );
  return new Map(rows.map((r) => [r.ticketId, { number: r.number, rating: r.rating }]));
}

/** Обращения с ответами помощника и оценкой ниже 4 за последние дни (список разбора, FR-AI-16). */
export async function lowRatedAiTickets(ctx: StaffContext, sinceDays = 90, limit = 100): Promise<string[]> {
  requireStaff(ctx);
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select({ ticketId: tickets.ticketId })
      .from(tickets)
      .where(and(isNotNull(tickets.csatScore), lt(tickets.csatScore, 4), gt(tickets.aiReplyCount, 0), sql`${tickets.createdOn} > now() - make_interval(days => ${sinceDays})`))
      .limit(limit),
  );
  return rows.map((r) => r.ticketId);
}
