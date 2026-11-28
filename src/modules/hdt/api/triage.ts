import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { markTriageAcceptedTx, pendingTriageTx } from '@/modules/hda/api/triage';
import { isActiveModule } from '@/modules/hdr/api';
import type { StaffContext } from '@/modules/hdu/api';
import { assertCanWrite, lockAgentTicket } from '../core/agent-actions';
import { HdtError } from '../error';
import { AI_HANDOFF_REASONS, type AiHandoffReason, TICKET_TYPES, type TicketType } from '../pref';
import { ticketEvents, tickets } from '../schema';

// Модуль hdt, слой api: принятие предложений разбора (план M5b, задача 7, решение 18; FR-TRI-02). Поле обращения
// меняется только по нажатию сотрудника, который ведёт обращения (product только читает): строка обращения
// блокируется, поля меняются, предложения отмечаются принятыми, событие истории triage_accepted (внутреннее) и запись
// журнала аудита пишутся той же транзакцией. "Принять всё" одной транзакцией, кроме заголовка (волна 7, S-M6): его
// видит клиент, поэтому он принимается только отдельным нажатием, где старый и новый заголовок стоят рядом. Резюме и пометка "проверьте приоритет"
// ничего в обращении не меняют: принятие только отмечает, что сотрудник их видел.

const FIELDS = ['module', 'type', 'title', 'summary', 'priority_hint'] as const;
const acceptInput = z.strictObject({
  number: z.coerce.number().int().positive(),
  fields: z.union([z.literal('all'), z.array(z.enum(FIELDS)).min(1).max(FIELDS.length)]),
});

export async function acceptTriage(ctx: StaffContext, input: unknown): Promise<{ accepted: number }> {
  assertCanWrite(ctx.actor);
  const parsed = acceptInput.safeParse(input);
  if (!parsed.success) throw new HdtError('invalid_input');
  const { number } = parsed.data;
  const fields = parsed.data.fields === 'all' ? FIELDS.filter((field) => field !== 'title') : parsed.data.fields;
  // Модуль из предложения проверяется до транзакции: справочник читает модуль hdr своим запросом.
  const preview = await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select({ ticketId: tickets.ticketId }).from(tickets).where(eq(tickets.number, number)).limit(1);
    return row ? pendingTriageTx(tx, row.ticketId, fields) : null;
  });
  if (!preview) throw new HdtError('not_found');
  const moduleValue = preview.find((s) => s.field === 'module')?.value;
  const moduleOk = moduleValue ? await isActiveModule(ctx.actor, moduleValue) : false;

  return withActor(ctx.actor, async (tx) => {
    const ticket = await lockAgentTicket(tx, number);
    const pending = await pendingTriageTx(tx, ticket.ticketId, fields);
    if (pending.length === 0) return { accepted: 0 };
    const [current] = await tx.select({ title: tickets.title }).from(tickets).where(eq(tickets.ticketId, ticket.ticketId)).limit(1);
    const patch: { title?: string; type?: TicketType; moduleId?: string } = {};
    const changes: Record<string, { from?: unknown; to?: unknown }> = {};
    const accepted: string[] = [];
    for (const s of pending) {
      if (s.field === 'module') {
        // Модуль стал недействующим после предложения: предложение остаётся ждущим.
        if (!moduleOk || s.value !== moduleValue) continue;
        patch.moduleId = s.value;
        changes.module = { from: ticket.moduleId, to: s.value };
      } else if (s.field === 'type') {
        if (!(TICKET_TYPES as readonly string[]).includes(s.value)) continue;
        patch.type = s.value as TicketType;
        changes.type = { from: ticket.type, to: s.value };
      } else if (s.field === 'title') {
        patch.title = s.value;
        changes.title = { from: current?.title ?? null, to: s.value };
      } else changes[s.field] = {};
      accepted.push(s.suggestionId);
    }
    if (accepted.length === 0) return { accepted: 0 };
    if (Object.keys(patch).length > 0) await tx.update(tickets).set(patch).where(eq(tickets.ticketId, ticket.ticketId));
    await markTriageAcceptedTx(tx, accepted, ctx.actor.userId, new Date());
    const payload = { fields: changes };
    await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'triage_accepted', actorType: 'staff', actorId: ctx.actor.userId, payload, isInternal: true });
    await writeAudit(tx, { action: 'ticket.triage_accepted', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: payload });
    return { accepted: accepted.length };
  });
}

/** Состояние помощника в обращении для блока AI сотрудника (FR-AI-13): состояние, причина и момент передачи, число ответов. */
export type TicketAiState = { aiState: string; aiReplyCount: number; aiHandoffReason: AiHandoffReason | null; aiHandoffOn: Date | null; title: string; description: string };

export async function ticketAiState(ctx: StaffContext, ticketId: string): Promise<TicketAiState | null> {
  if (ctx.actor.type !== 'staff') throw new HdtError('forbidden');
  const id = z.uuid().parse(ticketId);
  const [row] = await withActor(ctx.actor, (tx) =>
    tx
      .select({ aiState: tickets.aiState, aiReplyCount: tickets.aiReplyCount, aiHandoffReason: tickets.aiHandoffReason, aiHandoffOn: tickets.aiHandoffOn, title: tickets.title, description: tickets.description })
      .from(tickets)
      .where(eq(tickets.ticketId, id))
      .limit(1),
  );
  if (!row) return null;
  const reason = (AI_HANDOFF_REASONS as readonly string[]).includes(row.aiHandoffReason ?? '') ? (row.aiHandoffReason as AiHandoffReason) : null;
  return { ...row, aiState: row.aiState, aiHandoffReason: reason };
}
