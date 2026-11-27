import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type AgentActor, type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { problemTicketTx } from '@/modules/hdt/api/known-problems';
import { linkTicketTx } from '../core/links';
import { activeProblemBySignatureTx, insertProblemTx, insertSignatureTx, requireProblemTx } from '../core/problems';
import { HdpError, type HdpErrorCode } from '../error';
import { parseInput, problemNumberInput } from '../input';
import { pgErrorCode } from '../util';
import { ACTIVE_PROBLEM_STATUSES, PROBLEM_WRITER_ROLES } from '../pref';
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
    const signatures = await tx
      .select({ signature: problemSignatures.signature })
      .from(problemSignatures)
      .where(eq(problemSignatures.problemId, problem.problemId))
      .orderBy(asc(problemSignatures.signature));
    // Два одновременных принятия черновиков с одной сигнатурой (находка M2 независимой проверки): блокировка по
    // сигнатуре до проверки занятости, по порядку сигнатур; второе принятие видит первое и снимает сигнатуру.
    for (const { signature } of signatures) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hdp.signature:${signature}`}))`);
    let active = signatures.length > 0;
    for (const { signature } of signatures) {
      // Сигнатура у другой активной проблемы: снимается с черновика, иначе принятие нарушило бы её единственность.
      if (await activeProblemBySignatureTx(tx, signature)) {
        await tx.delete(problemSignatures).where(and(eq(problemSignatures.problemId, problem.problemId), eq(problemSignatures.signature, signature)));
        active = false;
      }
    }
    try {
      await tx.update(problems).set({ status: 'investigating' }).where(eq(problems.problemId, problem.problemId));
    } catch (error) {
      // Сигнатуру заняла проблема, ставшая активной другим путём (смена статуса, новая проблема): понятный отказ.
      if (pgErrorCode(error) === '23505') throw new HdpError('signature_taken');
      throw error;
    }
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

/** Сигнатуры из списка, у которых есть активная проблема или черновик (всплеск по ним не считается, решение 25). */
export async function signaturesWithProblemTx(tx: Tx, signatures: readonly string[]): Promise<Set<string>> {
  if (signatures.length === 0) return new Set();
  const rows = await tx
    .select({ signature: problemSignatures.signature })
    .from(problemSignatures)
    .innerJoin(problems, eq(problems.problemId, problemSignatures.problemId))
    .where(and(inArray(problemSignatures.signature, [...signatures]), inArray(problems.status, ['draft', ...ACTIVE_PROBLEM_STATUSES])));
  return new Set(rows.map((row) => row.signature));
}

const fromSignatureInput = z.strictObject({
  internalTitle: z.string().trim().min(1).max(200),
  signature: z.string().regex(SIGNATURE),
  ticketIds: z.array(z.uuid()).max(500),
});

/**
 * "Создать известную проблему" по всплеску сигнатуры (решение 25): решает сотрудник с правом ведения проблем, без
 * агента. Активная проблема с этой сигнатурой, владелец создатель, обращения окна привязаны общей функцией привязки
 * (закрытые и уже привязанные пропускаются). Сигнатура у другой активной проблемы: signature_taken.
 */
export async function createProblemFromSignature(ctx: StaffContext, input: unknown): Promise<{ problemId: string; number: number; linked: number }> {
  const actor = requireWriter(ctx);
  const data = parseInput(fromSignatureInput, input);
  return withActor(actor, async (tx) => {
    if (await activeProblemBySignatureTx(tx, data.signature)) throw new HdpError('signature_taken');
    const { problemId, number } = await insertProblemTx(tx, { internalTitle: data.internalTitle, moduleId: null, ownerId: actor.userId });
    await insertSignatureTx(tx, { problemId, signature: data.signature, addedBy: actor.userId });
    await writeAudit(tx, { action: 'problem.created', objectType: 'problem', objectId: problemId, diff: { number, fromSpike: true } });
    let linked = 0;
    for (const ticketId of data.ticketIds) {
      try {
        const outcome = await tx.transaction(async (inner) => (await linkTicketTx(inner, actor, { ticket: { ticketId }, problem: { problemId }, via: 'manual' })).result);
        if (outcome === 'linked') linked += 1;
      } catch (error) {
        if (!(error instanceof HdpError)) throw error;
      }
    }
    return { problemId, number, linked };
  });
}

/** Номера проблем по идентификаторам в транзакции вызывающего: блок всплесков. */
export async function problemNumbersTx(tx: Tx, problemIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(problemIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ problemId: problems.problemId, number: problems.number }).from(problems).where(inArray(problems.problemId, ids));
  return new Map(rows.map((row) => [row.problemId, row.number]));
}
