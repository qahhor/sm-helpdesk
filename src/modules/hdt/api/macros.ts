import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import type { StaffContext } from '@/modules/hdu/api';
import { assertCanWrite, lockAgentTicket } from '../core/agent-actions';
import { numberInput, parseInput } from '../input';
import type { Priority, Queue, TicketStatus } from '../pref';
import { ticketEvents, tickets, ticketTags } from '../schema';

// Модуль hdt, слой api: то, что берёт у обращений выполнение макросов (модуль hdw; план M8, задача 6). Сами действия
// макрос делает обычными действиями сотрудника из этого модуля (setStatus, assignTicket и другие): с теми же
// проверками прав и переходов. Здесь только состояние обращения перед действием и запись о запуске макроса.

/** Состояние обращения, по которому макрос решает, что менять нечего, и берёт язык для текста шаблона. */
export type MacroTicket = { ticketId: string; locale: string; status: TicketStatus; priority: Priority; queue: Queue; assigneeId: string | null; tagIds: string[] };

/** Обращение по номеру глазами сотрудника, который ведёт обращения. Нет такого: null. */
export async function macroTicket(ctx: StaffContext, number: unknown): Promise<MacroTicket | null> {
  assertCanWrite(ctx.actor);
  const parsed = parseInput(numberInput, number);
  return withActor(ctx.actor, async (tx) => {
    const [row] = await tx
      .select({ ticketId: tickets.ticketId, locale: tickets.locale, status: tickets.status, priority: tickets.priority, queue: tickets.queue, assigneeId: tickets.assigneeId })
      .from(tickets)
      .where(eq(tickets.number, parsed))
      .limit(1);
    if (!row) return null;
    const tags = await tx.select({ tagId: ticketTags.tagId }).from(ticketTags).where(eq(ticketTags.ticketId, row.ticketId));
    return { ...row, queue: row.queue as Queue, tagIds: tags.map((tag) => tag.tagId) };
  });
}

const actionDone = z.object({
  action: z.string().max(40),
  ok: z.boolean(),
  detail: z.string().max(40).optional(),
  from: z.string().max(300).nullable().optional(),
  to: z.string().max(300).nullable().optional(),
  unchanged: z.literal(true).optional(),
});
const runInput = z.strictObject({
  number: numberInput,
  macroId: z.uuid(),
  macroName: z.string().min(1).max(120),
  result: z.enum(['applied', 'partial', 'failed']),
  actions: z.array(actionDone).min(1).max(10),
});

/**
 * Запись о запуске макроса: одна внутренняя запись истории обращения (вид rule с отметкой macro, клиент её не видит:
 * ограничение hdt_ticket_events_c3) и запись журнала аудита macro.run в той же транзакции. В записи коды действий,
 * прежние и новые значения: текста заметок и шаблонов нет.
 */
export async function recordMacroRun(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(runInput, input);
  await withActor(ctx.actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, data.number);
    await tx.insert(ticketEvents).values({
      orgId: ticket.orgId,
      ticketId: ticket.ticketId,
      kind: 'rule',
      actorType: 'staff',
      actorId: ctx.actor.userId,
      payload: { macro: true, macroId: data.macroId, ruleName: data.macroName, actions: data.actions },
      isInternal: true,
    });
    await writeAudit(tx, {
      action: 'macro.run',
      objectType: 'ticket',
      objectId: ticket.ticketId,
      orgId: ticket.orgId,
      diff: { macroId: data.macroId, macroName: data.macroName, result: data.result, actions: data.actions },
    });
  });
}
