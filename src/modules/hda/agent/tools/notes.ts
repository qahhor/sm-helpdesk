import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { addAgentNoteTx } from '@/modules/hdt/api/agent-notes';
import { HdaAgentError } from '../../error';
import { AGENT_NOTE_MAX, AGENT_RUN_NOTE_MAX } from '../../pref';
import { defineTool } from '../tool';
import { AGENT_NOTICE, cleanAgentText, notice, UNTRUSTED_HINT } from '../util';
import { agentTicketsView } from '../views';

// Инструмент add_internal_note (веха M8b, задача 6; FR-AGT-04, 05, 07, 12; план M8b, решения 18, 19, 22): внутренняя
// заметка или черновик записки второй линии в обращение, видное агенту. Заметка видна только сотрудникам с пометкой
// "AI-сотрудник, не проверено", обычным текстом. Она не меняет обращение, сроки, исполнителя и не ставит уведомлений.
// У токена запуска одна заметка до 2000 знаков: предел держит база (триггер счётчика заметок).

/** Ошибка базы с именем ограничения: драйвер кладёт её в cause. */
function constraintOf(error: unknown): string | undefined {
  const own = (error as { constraint?: unknown }).constraint;
  const cause = (error as { cause?: { constraint?: unknown } }).cause?.constraint;
  return typeof own === 'string' ? own : typeof cause === 'string' ? cause : undefined;
}

export const addInternalNote = defineTool({
  name: 'add_internal_note',
  kind: 'write',
  description: `Add an internal note (kind "note") or a draft memo for the second line (kind "handoff_memo") to a ticket. Visible only to staff, marked "AI staff, not verified", shown as plain text. It never changes the ticket, its status, deadlines, assignee or notifications. HTML, invisible characters and links outside allowed domains are removed. Up to ${AGENT_NOTE_MAX} characters (a ticket run token: one note up to ${AGENT_RUN_NOTE_MAX}). ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    ticket_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['note', 'handoff_memo']).default('note'),
    body: z.string().min(1).max(AGENT_NOTE_MAX),
  }),
  output: z.strictObject({ notice, note: z.strictObject({ ticket_number: z.number().int(), kind: z.enum(['note', 'handoff_memo']) }) }),
  // Адреса для ссылок читает система до транзакции агента (находка I3).
  prepare: () => readAllowedDomains(),
  async run(tx, actor, args, domains) {
    if (actor.ticketId !== null && args.body.length > AGENT_RUN_NOTE_MAX) throw new HdaAgentError('invalid_arguments');
    const [ticket] = await tx
      .select({ ticketId: agentTicketsView.ticketId, orgId: agentTicketsView.orgId })
      .from(agentTicketsView)
      .where(eq(agentTicketsView.number, args.ticket_number))
      .limit(1);
    if (!ticket) throw new HdaAgentError('not_found');
    const body = cleanAgentText(args.body, domains);
    if (!body) throw new HdaAgentError('invalid_arguments');
    try {
      await addAgentNoteTx(tx, actor, { ticketId: ticket.ticketId, orgId: ticket.orgId, kind: args.kind, body });
    } catch (error) {
      if (constraintOf(error) === 'hda_agent_tokens_c9') throw new HdaAgentError('note_limit');
      throw error;
    }
    return { result: { notice: AGENT_NOTICE, note: { ticket_number: args.ticket_number, kind: args.kind } }, objectRefs: [{ kind: 'ticket' as const, ref: args.ticket_number }] };
  },
});

export const noteTools = [addInternalNote];
