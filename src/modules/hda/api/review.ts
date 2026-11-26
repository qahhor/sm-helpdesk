import 'server-only';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { cleanUserText } from '@/modules/hdc/pref';
import { aiAnswerMessage, lowRatedAiTickets, ticketsForAiReview } from '@/modules/hdt/api/ai-review';
import { HdaError } from '../error';
import { AI_FLAG_REASONS, AI_REVIEW_RESULTS, AI_REVIEW_SAMPLE_DAYS, AI_REVIEW_SAMPLE_SIZE, type AiFlagReason, type AiReviewResult } from '../pref';
import { aiRuns } from '../schema';

// Модуль hda, слой api: отметка неверных ответов помощника и список разбора (план M5b, задача 8; FR-AI-16). Отметку
// ставит сотрудник, который ведёт обращения; итог разбора пишут вторая линия, care и администратор. Оба действия с
// записью журнала аудита той же транзакцией. Клиент строк журнала вызовов не видит (политики миграций 0072, 0094).

const WRITE_ROLES: readonly string[] = ['agent_l1', 'agent_l2', 'care', 'admin'];
const REVIEW_ROLES: readonly string[] = ['agent_l2', 'care', 'admin'];

function requireStaff(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff') throw new HdaError('forbidden');
}

const flagInput = z.strictObject({
  messageId: z.uuid(),
  reason: z.enum(AI_FLAG_REASONS),
  comment: z.string().max(2000).optional().default(''),
});

/** "Отметить ответ как неверный" у сообщения помощника с ответом решением или вопросом. */
export async function flagAiAnswer(ctx: StaffContext, input: unknown): Promise<void> {
  requireStaff(ctx);
  if (!WRITE_ROLES.includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
  const parsed = flagInput.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  const comment = cleanUserText(parsed.data.comment).trim().slice(0, 500);
  const message = await aiAnswerMessage(ctx, parsed.data.messageId);
  if (!message) throw new HdaError('invalid_input');
  await withActor(ctx.actor, async (tx) => {
    // Вызов, по которому написано сообщение: ответ или вопрос этого обращения, ближайший по времени к сообщению.
    const [run] = await tx
      .select({ runId: aiRuns.runId })
      .from(aiRuns)
      .where(and(eq(aiRuns.ticketId, message.ticketId), inArray(aiRuns.decision, ['answer', 'clarify'])))
      .orderBy(sql`abs(extract(epoch from ${aiRuns.createdOn} - ${message.createdOn.toISOString()}::timestamptz))`)
      .limit(1);
    if (!run) throw new HdaError('invalid_input');
    await tx
      .update(aiRuns)
      .set({ flaggedBy: ctx.actor.userId, flaggedOn: new Date(), flagReason: parsed.data.reason, flagComment: comment === '' ? null : comment })
      .where(eq(aiRuns.runId, run.runId));
    await writeAudit(tx, { action: 'ticket.ai_answer_flagged', objectType: 'ticket', objectId: message.ticketId, orgId: message.orgId, diff: { runId: run.runId, reason: parsed.data.reason } });
  });
}

/** Итог разбора отмеченного или выбранного ответа. */
export async function reviewAiAnswer(ctx: StaffContext, input: unknown): Promise<void> {
  requireStaff(ctx);
  if (!REVIEW_ROLES.includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
  const parsed = z.strictObject({ runId: z.uuid(), result: z.enum(AI_REVIEW_RESULTS) }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, async (tx) => {
    const [row] = await tx
      .update(aiRuns)
      .set({ reviewResult: parsed.data.result })
      .where(and(eq(aiRuns.runId, parsed.data.runId), inArray(aiRuns.decision, ['answer', 'clarify'])))
      .returning({ ticketId: aiRuns.ticketId, orgId: aiRuns.orgId });
    if (!row) throw new HdaError('invalid_input');
    await writeAudit(tx, {
      action: 'ticket.ai_answer_reviewed',
      objectType: 'ticket',
      ...(row.ticketId ? { objectId: row.ticketId } : {}),
      ...(row.orgId ? { orgId: row.orgId } : {}),
      diff: { runId: parsed.data.runId, result: parsed.data.result },
    });
  });
}

export type AiReviewRow = {
  runId: string;
  ticketId: string;
  number: number;
  solutionId: string | null;
  /** Номер показанного решения из найденных этим вызовом. */
  solutionNumber: number | null;
  flagReason: AiFlagReason | null;
  flagComment: string | null;
  reviewResult: AiReviewResult | null;
  rating: number | null;
  createdOn: Date;
};

/** Список разбора: отмеченные ответы, ответы в обращениях с оценкой ниже 4, выборка последних двух недель (15.6). */
export async function aiReviewList(ctx: StaffContext): Promise<{ flagged: AiReviewRow[]; lowRated: AiReviewRow[]; sample: AiReviewRow[] }> {
  requireStaff(ctx);
  const lowIds = await lowRatedAiTickets(ctx);
  const select = {
    runId: aiRuns.runId,
    ticketId: aiRuns.ticketId,
    solutionId: aiRuns.solutionId,
    found: aiRuns.found,
    flagReason: aiRuns.flagReason,
    flagComment: aiRuns.flagComment,
    reviewResult: aiRuns.reviewResult,
    createdOn: aiRuns.createdOn,
  };
  const { flagged, lowRated, sample } = await withActor(ctx.actor, async (tx) => ({
    flagged: await tx.select(select).from(aiRuns).where(isNotNull(aiRuns.flaggedBy)).orderBy(desc(aiRuns.flaggedOn)).limit(100),
    lowRated: lowIds.length > 0 ? await tx.select(select).from(aiRuns).where(and(inArray(aiRuns.ticketId, lowIds), eq(aiRuns.decision, 'answer'))).orderBy(desc(aiRuns.createdOn)).limit(100) : [],
    sample: await tx
      .select(select)
      .from(aiRuns)
      .where(and(eq(aiRuns.decision, 'answer'), gte(aiRuns.createdOn, sql`now() - make_interval(days => ${AI_REVIEW_SAMPLE_DAYS})`)))
      .orderBy(desc(aiRuns.createdOn))
      .limit(AI_REVIEW_SAMPLE_SIZE),
  }));
  const ids = [...flagged, ...lowRated, ...sample].flatMap((r) => (r.ticketId ? [r.ticketId] : []));
  const facts = await ticketsForAiReview(ctx, ids);
  const toRows = (rows: typeof flagged): AiReviewRow[] =>
    rows.flatMap((r) => {
      const ticket = r.ticketId ? facts.get(r.ticketId) : undefined;
      if (!r.ticketId || !ticket) return [];
      return [
        {
          runId: r.runId,
          ticketId: r.ticketId,
          number: ticket.number,
          solutionId: r.solutionId,
          solutionNumber: r.found?.find((f) => f.articleId === r.solutionId)?.number ?? null,
          flagReason: (AI_FLAG_REASONS as readonly string[]).includes(r.flagReason ?? '') ? (r.flagReason as AiFlagReason) : null,
          flagComment: r.flagComment,
          reviewResult: (AI_REVIEW_RESULTS as readonly string[]).includes(r.reviewResult ?? '') ? (r.reviewResult as AiReviewResult) : null,
          rating: ticket.rating,
          createdOn: r.createdOn,
        },
      ];
    });
  return { flagged: toRows(flagged), lowRated: toRows(lowRated), sample: toRows(sample) };
}

export { isHdaError } from '../error';
