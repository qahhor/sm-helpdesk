import 'server-only';
import { and, desc, eq, or, type SQL } from 'drizzle-orm';
import { containsText } from '@/db/contains';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { type StaffContext, writeAudit } from '@/modules/hdc/api';
import { addSolutionSourcesTx, createSolutionFromCandidateTx } from '@/modules/hdk/api/from-candidate';
import { bumpStaffUseful, nearestPublished } from '@/modules/hdk/api/similar';
import { KB_WRITER_ROLES } from '@/modules/hdk/pref';
import type { TemplateLabels } from '@/modules/hdk/api/doc';
import { ticketNumbersTx } from '@/modules/hdt/api/dev-tasks';
import { HdaError } from '../error';
import { CANDIDATE_REJECT_REASONS, CANDIDATE_STATUSES, type CandidateRejectReason, type CandidateStatus } from '../pref';
import { type CandidateFinding, candidateSources, solutionCandidates } from '../schema';

// Модуль hda, слой api: очередь кандидатов и решение из кандидата (ТЗ FR-CAND-04, 06, 09; план M5c, задача 10,
// решение 29). Читают и решают роли с правом черновика решения (все, кроме product), каждое действие с записью журнала
// аудита. Источники кандидата видят только сотрудники. Кандидат не попадает в поиск: подсказка и помощник находят
// решение только после публикации обычным порядком.

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdaError('forbidden');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  return parsed.data;
}

export type CandidateRow = { candidateId: string; title: string; moduleId: string | null; status: CandidateStatus; sourceCount: number; orgCount: number; createdOn: Date };

const listInput = z.strictObject({ moduleId: z.uuid().optional(), q: z.string().trim().max(200).optional(), status: z.enum(CANDIDATE_STATUSES).optional() });

/** Очередь (8.12): по умолчанию новые; больше источников и организаций сверху (FR-CAND-04). */
export async function listCandidates(ctx: StaffContext, input: unknown): Promise<CandidateRow[]> {
  requireWriter(ctx);
  const data = parse(listInput, input ?? {});
  const where: SQL[] = [eq(solutionCandidates.status, data.status ?? 'new')];
  if (data.moduleId) where.push(eq(solutionCandidates.moduleId, data.moduleId));
  if (data.q) where.push(or(containsText(solutionCandidates.title, data.q), containsText(solutionCandidates.problem, data.q))!);
  return withActor(ctx.actor, (tx) =>
    tx
      .select({
        candidateId: solutionCandidates.candidateId,
        title: solutionCandidates.title,
        moduleId: solutionCandidates.moduleId,
        status: solutionCandidates.status,
        sourceCount: solutionCandidates.sourceCount,
        orgCount: solutionCandidates.orgCount,
        createdOn: solutionCandidates.createdOn,
      })
      .from(solutionCandidates)
      .where(and(...where))
      .orderBy(desc(solutionCandidates.sourceCount), desc(solutionCandidates.orgCount), desc(solutionCandidates.createdOn))
      .limit(200),
  );
}

export type CandidateCard = CandidateRow & {
  locale: string;
  problem: string;
  steps: string[];
  findings: CandidateFinding[];
  rejectReason: CandidateRejectReason | null;
  articleId: string | null;
  /** Номера обращений-источников: только сотрудникам. */
  sourceTickets: number[];
  /** Ближайшее опубликованное решение по вектору (идентификатор и сходство), если вектор есть. */
  similar: { articleId: string; similarity: number } | null;
};

const idInput = z.strictObject({ id: z.uuid() });

/** Карточка кандидата: текст с находками, источники, похожее решение. Нет кандидата: null. */
export async function candidateCard(ctx: StaffContext, input: unknown): Promise<CandidateCard | null> {
  requireWriter(ctx);
  const { id } = parse(idInput, input);
  const loaded = await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(solutionCandidates).where(eq(solutionCandidates.candidateId, id)).limit(1);
    if (!row) return null;
    const sources = await tx.select({ ticketId: candidateSources.ticketId }).from(candidateSources).where(eq(candidateSources.candidateId, id));
    const numbers = await ticketNumbersTx(tx, sources.map((s) => s.ticketId));
    return { row, tickets: [...numbers.values()].sort((a, b) => a - b) };
  });
  if (!loaded) return null;
  const { row } = loaded;
  const similar = row.embedding ? await nearestPublished(ctx.actor, { vector: row.embedding }) : null;
  return {
    candidateId: row.candidateId,
    title: row.title,
    moduleId: row.moduleId,
    status: row.status,
    sourceCount: row.sourceCount,
    orgCount: row.orgCount,
    createdOn: row.createdOn,
    locale: row.locale,
    problem: row.problem,
    steps: row.steps,
    findings: row.findings,
    rejectReason: row.rejectReason,
    articleId: row.articleId,
    sourceTickets: loaded.tickets,
    similar,
  };
}

/** Кандидат, ждущий решения, с блокировкой строки и его источники. Решён: invalid_input. */
async function openCandidateTx(tx: Parameters<Parameters<typeof withActor>[1]>[0], id: string) {
  const [row] = await tx.select().from(solutionCandidates).where(eq(solutionCandidates.candidateId, id)).limit(1).for('update');
  if (!row) throw new HdaError('not_found');
  if (row.status !== 'new' && row.status !== 'rejected') throw new HdaError('invalid_input');
  const sources = await tx.select({ ticketId: candidateSources.ticketId, orgId: candidateSources.orgId }).from(candidateSources).where(eq(candidateSources.candidateId, id));
  return { row, sources };
}

/**
 * "Сделать черновиком решения" (решение 29): решение-черновик с аудиторией internal, текстом кандидата в заготовке,
 * всеми источниками и признаком недоверенного текста; кандидат accepted. Одна транзакция с журналом.
 */
export async function candidateToDraft(ctx: StaffContext, input: unknown, labels: TemplateLabels, newId: () => string): Promise<{ articleNumber: number }> {
  requireWriter(ctx);
  const { id } = parse(idInput, input);
  return withActor(ctx.actor, async (tx) => {
    const { row, sources } = await openCandidateTx(tx, id);
    if (sources.length === 0) throw new HdaError('invalid_input');
    const article = await createSolutionFromCandidateTx(
      tx,
      ctx.actor as Extract<StaffContext['actor'], { type: 'staff' }>,
      { locale: row.locale as 'ru' | 'uz' | 'en', title: row.title, problem: row.problem, steps: row.steps, moduleId: row.moduleId, sources },
      labels,
      newId,
    );
    await tx.update(solutionCandidates).set({ status: 'accepted', articleId: article.articleId, decidedBy: ctx.actor.userId, decidedOn: new Date() }).where(eq(solutionCandidates.candidateId, id));
    await writeAudit(tx, { action: 'candidate.accepted', objectType: 'candidate', objectId: id, diff: { articleNumber: article.number, sources: sources.length } });
    return { articleNumber: article.number };
  });
}

const mergeInput = z.strictObject({ id: z.uuid(), articleNumber: z.int().positive().max(999_999_999_999) });

/** "Объединить с решением" (решение 29): источники к решению, кандидат merged, "пригодилось сотрудникам" растёт. */
export async function mergeCandidate(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parse(mergeInput, input);
  const { articleId, count } = await withActor(ctx.actor, async (tx) => {
    const { sources } = await openCandidateTx(tx, data.id);
    const { articleId } = await addSolutionSourcesTx(tx, { articleNumber: data.articleNumber, sources }).catch(() => {
      throw new HdaError('not_found');
    });
    await tx.update(solutionCandidates).set({ status: 'merged', articleId, decidedBy: ctx.actor.userId, decidedOn: new Date() }).where(eq(solutionCandidates.candidateId, data.id));
    await writeAudit(tx, { action: 'candidate.merged', objectType: 'candidate', objectId: data.id, diff: { articleNumber: data.articleNumber, sources: sources.length } });
    return { articleId, count: sources.length };
  });
  if (count > 0) await bumpStaffUseful(ctx.actor, { articleId, by: count });
}

const rejectInput = z.strictObject({ id: z.uuid(), reason: z.enum(CANDIDATE_REJECT_REASONS), comment: z.string().trim().max(1000).optional() });

/** "Отклонить" с причиной из списка (решение 29): запоминается число источников, на пятом новом кандидат вернётся. */
export async function rejectCandidate(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parse(rejectInput, input);
  await withActor(ctx.actor, async (tx) => {
    const { row } = await openCandidateTx(tx, data.id);
    await tx
      .update(solutionCandidates)
      .set({ status: 'rejected', rejectReason: data.reason, rejectComment: data.comment || null, rejectedAtSourceCount: row.sourceCount, decidedBy: ctx.actor.userId, decidedOn: new Date() })
      .where(eq(solutionCandidates.candidateId, data.id));
    await writeAudit(tx, { action: 'candidate.rejected', objectType: 'candidate', objectId: data.id, diff: { reason: data.reason, sources: row.sourceCount } });
  });
}

export { CANDIDATE_REJECT_REASONS, type CandidateRejectReason } from '../pref';
