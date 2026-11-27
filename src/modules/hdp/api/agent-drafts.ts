import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type AgentActor, type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { problemTicketTx } from '@/modules/hdt/api/known-problems';
import { linkTicketTx } from '../core/links';
import { activeProblemBySignatureTx, requireProblemTx } from '../core/problems';
import { HdpError, type HdpErrorCode } from '../error';
import { parseInput, problemNumberInput } from '../input';
import { PROBLEM_WRITER_ROLES } from '../pref';
import { problemProposals, problems, problemSignatures } from '../schema';

// Модуль hdp, слой api: черновик известной проблемы (веха M8b, задача 6; FR-AGT-04, 05, T23; план M8b, решение 20).
// Черновик заводят AI-сотрудник (инструмент draft_known_problem) и система (всплеск сигнатуры). Он не меняет ни одного
// обращения: статус draft, сигнатура неактивна (база ставит активность по статусу), обращения только предложены в
// hdp_problem_proposals. Сотрудник с правом ведения проблем (agent_l2, care, admin) принимает черновик (проблема
// активна, сигнатура действует, если её не ведёт другая активная проблема), привязывает предложенные общей функцией
// привязки с итогом по каждому обращению или отклоняет (closed без рассылки). Каждое действие с журналом аудита.

export type DraftProposal = { ticketId: string; orgId: string };

const SIGNATURE = /^[0-9a-f]{32}$/;
const numberOnly = z.strictObject({ number: problemNumberInput });
const agentDraftInput = z.strictObject({
  internalTitle: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  signature: z.string().regex(SIGNATURE).nullable(),
  proposals: z.array(z.strictObject({ ticketId: z.uuid(), orgId: z.uuid() })).max(100),
});

/** Черновик проблемы от AI-сотрудника в транзакции его инструмента. Без returning: читать проблемы агенту не дано. */
export async function createProblemDraftFromAgentTx(tx: Tx, actor: AgentActor, value: z.input<typeof agentDraftInput>): Promise<{ problemId: string; number: number }> {
  if (actor.type !== 'agent' || actor.ticketId !== null) throw new HdpError('forbidden');
  const data = parseInput(agentDraftInput, value);
  const problemId = randomUUID();
  const numbered = await tx.execute<{ number: string }>(sql`select nextval('hdp_problems_number_sq')::text as number`);
  const number = Number(numbered.rows[0]!.number);
  await tx.insert(problems).values({ problemId, number, internalTitle: data.internalTitle, internalDescription: data.description || null, status: 'draft', showToClients: false });
  if (data.signature) await tx.insert(problemSignatures).values({ problemId, signature: data.signature, addedBy: null });
  if (data.proposals.length > 0) await tx.insert(problemProposals).values(data.proposals.map((p) => ({ ...p, problemId })));
  return { problemId, number };
}

const systemDraftInput = z.strictObject({
  internalTitle: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  signature: z.string().regex(SIGNATURE),
  ticketIds: z.array(z.uuid()).max(500),
});

/** Черновик проблемы от системы (всплеск сигнатуры): те же правила, обращения предложены, не привязаны. */
export async function createSystemProblemDraft(system: SystemActor, value: unknown): Promise<{ number: number; proposed: number }> {
  const data = parseInput(systemDraftInput, value);
  return withActor(system, async (tx) => {
    const [row] = await tx
      .insert(problems)
      .values({ internalTitle: data.internalTitle, internalDescription: data.description ?? null, status: 'draft', showToClients: false })
      .returning({ problemId: problems.problemId, number: problems.number });
    await tx.insert(problemSignatures).values({ problemId: row!.problemId, signature: data.signature, addedBy: null });
    const proposals: DraftProposal[] = [];
    for (const ticketId of [...new Set(data.ticketIds)]) {
      const ticket = await problemTicketTx(tx, { ticketId });
      if (ticket && ticket.knownProblemId === null) proposals.push({ ticketId, orgId: ticket.orgId });
    }
    if (proposals.length > 0) await tx.insert(problemProposals).values(proposals.map((p) => ({ ...p, problemId: row!.problemId })));
    await writeAudit(tx, { action: 'problem.created', objectType: 'problem', objectId: row!.problemId, diff: { number: row!.number, draft: true, proposed: proposals.length } });
    return { number: row!.number, proposed: proposals.length };
  });
}

function requireWriter(ctx: StaffContext): StaffActor {
  if (ctx.actor.type !== 'staff' || !(PROBLEM_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdpError('forbidden');
  return ctx.actor;
}

/** "Принять черновик": статус investigating; сигнатура действует, если её не ведёт другая активная проблема. */
export async function acceptProblemDraft(ctx: StaffContext, input: unknown): Promise<{ signatureActive: boolean }> {
  const actor = requireWriter(ctx);
  const { number } = parseInput(numberOnly, input);
  return withActor(actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number }, { lock: true });
    if (problem.status !== 'draft') throw new HdpError('not_draft');
    const signatures = await tx.select({ signature: problemSignatures.signature }).from(problemSignatures).where(eq(problemSignatures.problemId, problem.problemId));
    let active = signatures.length > 0;
    for (const { signature } of signatures) {
      // Сигнатура у другой активной проблемы: снимается с черновика, иначе принятие нарушило бы её единственность.
      if (await activeProblemBySignatureTx(tx, signature)) {
        await tx.delete(problemSignatures).where(and(eq(problemSignatures.problemId, problem.problemId), eq(problemSignatures.signature, signature)));
        active = false;
      }
    }
    await tx.update(problems).set({ status: 'investigating' }).where(eq(problems.problemId, problem.problemId));
    await writeAudit(tx, { action: 'problem.draft_accepted', objectType: 'problem', objectId: problem.problemId, diff: { number, signatureActive: active } });
    return { signatureActive: active };
  });
}

export type ProposalOutcome = 'linked' | 'unchanged' | Extract<HdpErrorCode, 'already_linked' | 'ticket_closed' | 'problem_closed' | 'not_found'>;

/** "Привязать предложенные": только у принятой проблемы, общей функцией привязки, итог по каждому обращению. */
export async function linkProposedTickets(ctx: StaffContext, input: unknown): Promise<{ items: { number: number; outcome: ProposalOutcome }[] }> {
  const actor = requireWriter(ctx);
  const { number } = parseInput(numberOnly, input);
  return withActor(actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number });
    if (problem.status === 'draft') throw new HdpError('not_accepted');
    const proposals = await tx.select().from(problemProposals).where(eq(problemProposals.problemId, problem.problemId)).orderBy(asc(problemProposals.createdOn));
    const items: { number: number; outcome: ProposalOutcome }[] = [];
    for (const proposal of proposals) {
      const ticket = await problemTicketTx(tx, { ticketId: proposal.ticketId });
      let outcome: ProposalOutcome;
      try {
        // Точка сохранения: отказ по одному обращению не отменяет остальные.
        outcome = await tx.transaction(async (inner) => (await linkTicketTx(inner, actor, { ticket: { ticketId: proposal.ticketId }, problem: { problemId: problem.problemId }, via: 'manual' })).result);
      } catch (error) {
        if (!(error instanceof HdpError)) throw error;
        outcome = (['already_linked', 'ticket_closed', 'problem_closed'] as const).find((code) => code === error.code) ?? 'not_found';
      }
      items.push({ number: ticket?.number ?? 0, outcome });
    }
    await tx.delete(problemProposals).where(eq(problemProposals.problemId, problem.problemId));
    const linked = items.filter((item) => item.outcome === 'linked').length;
    await writeAudit(tx, { action: 'problem.proposals_linked', objectType: 'problem', objectId: problem.problemId, diff: { number, linked, skipped: items.length - linked } });
    return { items };
  });
}

const rejectInput = z.strictObject({ number: problemNumberInput, reason: z.string().trim().max(500) });

/** "Отклонить черновик": статус closed без рассылки, без момента исправления. */
export async function rejectProblemDraft(ctx: StaffContext, input: unknown): Promise<void> {
  const actor = requireWriter(ctx);
  const { number, reason } = parseInput(rejectInput, input);
  await withActor(actor, async (tx) => {
    const problem = await requireProblemTx(tx, { number }, { lock: true });
    if (problem.status !== 'draft') throw new HdpError('not_draft');
    await tx.update(problems).set({ status: 'closed' }).where(eq(problems.problemId, problem.problemId));
    await tx.delete(problemProposals).where(eq(problemProposals.problemId, problem.problemId));
    await writeAudit(tx, { action: 'problem.draft_rejected', objectType: 'problem', objectId: problem.problemId, diff: { number, reason } });
  });
}

/** Предложенные обращения черновика для карточки проблемы. */
export async function proposalsTx(tx: Tx, problemId: string): Promise<{ ticketId: string; orgId: string }[]> {
  return tx.select({ ticketId: problemProposals.ticketId, orgId: problemProposals.orgId }).from(problemProposals).where(eq(problemProposals.problemId, problemId)).orderBy(asc(problemProposals.createdOn));
}
