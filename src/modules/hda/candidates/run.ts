import 'server-only';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { enqueue, readSetting, writeAudit } from '@/modules/hdc/api';
import { stripQuote } from '@/modules/hdn/api/inbound';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { bumpMachineMatch, nearestPublished, ticketsWithSolutionSource } from '@/modules/hdk/api/similar';
import { queryVector } from '@/modules/hdk/api/suggest';
import { findInText } from '@/modules/hdk/api/text-checks';
import { resolvedWithoutSolution, ticketSolutionSource } from '@/modules/hdt/api/solution-source';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { assembleDraftData } from '../assemble';
import { stripForeignLinks, URL_IN_TEXT } from '../links';
import { DRAFT_SYSTEM, draftSchema, type SolutionDraft } from '../api/draft';
import { callAi } from '../api/run';
import { recordDecisionTx } from '../core/runs';
import { AI_DAY_TIME_ZONE, CANDIDATE_DEFAULTS, CANDIDATE_LOOKBACK_DAYS, CANDIDATE_RESOLUTIONS, CANDIDATE_SETTINGS, CANDIDATE_VECTOR_ATTEMPTS } from '../pref';
import { aiRuns, type CandidateFinding, candidateSources, solutionCandidates } from '../schema';
import { candidateMergeDecision, distinctOrgCount, returnsFromRejected } from './merge';

// Модуль hda, кандидаты в решения (ТЗ 7.16, FR-CAND-01, 02, 03, 05, 07, 09, 14.3; план M5c, задача 9, решения 26-28).
// Обход ai.candidates_sweep раз в 15 минут ставит задание ai.candidate на каждое обращение, решённое за 7 суток с итогом
// solved или workaround, без решения из базы, без источника решения, у организации с AI-обработкой и без прошлого
// вызова этой цели (журнал hda_runs: итог ok или invalid_response). Задание готовит черновик тем же входом и схемой,
// что черновик решения (assembleDraftData, draftSchema), вырезает ссылки вне разрешённых доменов, подсвечивает
// телефоны, почту и другие находки и склеивает похожие по векторам. Кандидат живёт только в hda_solution_candidates:
// в поисковый индекс он не попадает (FR-CAND-06). Пишет только система.

const DRAFT_MAX_TOKENS = 1500;
const SWEEP_MAX = 200;
const EMBED_MAX = 200;

export type CandidateConfig = { enabled: boolean; dailyLimit: number; publishedSimilarity: number; mergeSimilarity: number };

export const candidateConfigSchemas = {
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(0).max(1000),
  publishedSimilarity: z.number().min(0).max(1),
  mergeSimilarity: z.number().min(0).max(1),
} as const;

/** Настройки кандидатов: нет строки или значение неверно, значение по умолчанию (решения 26, 28). */
export async function candidateConfig(): Promise<CandidateConfig> {
  const read = async <K extends keyof CandidateConfig>(key: K): Promise<CandidateConfig[K]> => {
    const parsed = candidateConfigSchemas[key].safeParse(await readSetting(CANDIDATE_SETTINGS[key]));
    return (parsed.success ? parsed.data : CANDIDATE_DEFAULTS[key]) as CandidateConfig[K];
  };
  return { enabled: await read('enabled'), dailyLimit: await read('dailyLimit'), publishedSimilarity: await read('publishedSimilarity'), mergeSimilarity: await read('mergeSimilarity') };
}

function requireSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new Error('hda: кандидатов пишет только система');
}

/** Обращения из списка, по которым кандидат уже готовился (ответ модели был) или которые уже источник кандидата. */
async function processedTx(tx: Tx, ticketIds: readonly string[]): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  const runs = await tx
    .select({ ticketId: aiRuns.ticketId })
    .from(aiRuns)
    .where(and(eq(aiRuns.purpose, 'candidate'), inArray(aiRuns.ticketId, [...ticketIds]), inArray(aiRuns.outcome, ['ok', 'invalid_response'])));
  const sources = await tx.select({ ticketId: candidateSources.ticketId }).from(candidateSources).where(inArray(candidateSources.ticketId, [...ticketIds]));
  return new Set([...runs.flatMap((r) => (r.ticketId ? [r.ticketId] : [])), ...sources.map((s) => s.ticketId)]);
}

/** Обход (решение 26): ставит задание на каждое подходящее обращение. Идемпотентен: повтор ничего не добавит. */
export async function runCandidatesSweep(system: SystemActor, opts: { now?: Date } = {}): Promise<{ queued: number }> {
  requireSystem(system);
  const config = await candidateConfig();
  if (!config.enabled) return { queued: 0 };
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - CANDIDATE_LOOKBACK_DAYS * 86_400_000);
  const found = await resolvedWithoutSolution(system, { since, resolutions: [...CANDIDATE_RESOLUTIONS], limit: SWEEP_MAX });
  if (found.length === 0) return { queued: 0 };
  const ids = found.map((t) => t.ticketId);
  const withSource = await ticketsWithSolutionSource(system, ids);
  const done = await withActor(system, (tx) => processedTx(tx, ids));
  const aiOn = new Map<string, boolean>();
  let queued = 0;
  for (const t of found) {
    if (withSource.has(t.ticketId) || done.has(t.ticketId)) continue;
    if (!aiOn.has(t.orgId)) aiOn.set(t.orgId, (await orgAiProfile(system, { orgId: t.orgId, userIds: [] }))?.isAiEnabled === true);
    if (!aiOn.get(t.orgId)) continue;
    await enqueue('ai.candidate', { ticketId: t.ticketId });
    queued += 1;
  }
  return { queued };
}

/** Вызовов модели на кандидатов за сутки по Ташкенту (решение 26): предел candidates.daily_limit. */
async function callsTodayTx(tx: Tx): Promise<number> {
  const dayStart = sql`date_trunc('day', now() at time zone ${AI_DAY_TIME_ZONE}) at time zone ${AI_DAY_TIME_ZONE}`;
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(and(eq(aiRuns.purpose, 'candidate'), gte(aiRuns.createdOn, dayStart), inArray(aiRuns.outcome, ['ok', 'invalid_response', 'failed'])));
  return row?.count ?? 0;
}

export { stripForeignLinks };

/** Черновик после очистки: ссылки вырезаны, находки собраны для подсветки (телефоны, почта, ИНН и другие). */
function cleanDraft(draft: SolutionDraft, allowedDomains: readonly string[]): { title: string; problem: string; steps: string[]; findings: CandidateFinding[] } {
  const title = stripForeignLinks(draft.title, allowedDomains).slice(0, 140) || draft.title.replace(URL_IN_TEXT, '').trim().slice(0, 140);
  const problem = stripForeignLinks(draft.problem, allowedDomains).slice(0, 1200);
  const steps = draft.steps.map((s) => stripForeignLinks(s, allowedDomains)).filter(Boolean).slice(0, 12);
  const findings = [title, problem, ...steps].flatMap((text) => findInText(text).map((hit) => ({ kind: hit.kind, text: hit.text })));
  return { title, problem, steps, findings };
}

/** Текст для вектора кандидата: заголовок и проблема (решение 28). */
const vectorText = (c: { title: string; problem: string }) => `${c.title}\n${c.problem}`;

/** Вектор с повторами: сервис недоступен CANDIDATE_VECTOR_ATTEMPTS раз подряд, null (кандидат без склейки). */
async function vectorWithRetries(text: string): Promise<number[] | null> {
  for (let i = 0; i < CANDIDATE_VECTOR_ATTEMPTS; i++) {
    const vector = await queryVector(text);
    if (vector) return vector;
  }
  return null;
}

/** Ближайший кандидат new или rejected (кроме except) по косинусному сходству. */
async function nearestCandidateTx(tx: Tx, vector: readonly number[], except?: string): Promise<{ id: string; status: 'new' | 'rejected'; similarity: number } | null> {
  const v = JSON.stringify(vector);
  const rows = await tx.execute<{ candidate_id: string; status: 'new' | 'rejected'; similarity: number }>(sql`
    select c.candidate_id, c.status, 1 - (c.embedding <=> ${v}::vector) as similarity
      from hda_solution_candidates c
     where c.status in ('new', 'rejected') and c.embedding is not null ${except ? sql`and c.candidate_id <> ${except}` : sql``}
     order by c.embedding <=> ${v}::vector
     limit 1`);
  const row = rows.rows[0];
  return row ? { id: row.candidate_id, status: row.status, similarity: Number(row.similarity) } : null;
}

/** Пересчёт источников и организаций; отклонённый с пятью новыми источниками возвращается в new с журналом. */
async function recountTx(tx: Tx, candidateId: string): Promise<void> {
  const sources = await tx.select({ orgId: candidateSources.orgId }).from(candidateSources).where(eq(candidateSources.candidateId, candidateId));
  const [c] = await tx.select({ status: solutionCandidates.status, rejectedAt: solutionCandidates.rejectedAtSourceCount }).from(solutionCandidates).where(eq(solutionCandidates.candidateId, candidateId)).for('update');
  if (!c) return;
  const sourceCount = sources.length;
  const back = c.status === 'rejected' && returnsFromRejected({ sourceCount, rejectedAtSourceCount: c.rejectedAt });
  await tx
    .update(solutionCandidates)
    .set({ sourceCount, orgCount: distinctOrgCount(sources), ...(back ? { status: 'new' as const } : {}) })
    .where(eq(solutionCandidates.candidateId, candidateId));
  if (back) await writeAudit(tx, { action: 'candidate.returned', objectType: 'candidate', objectId: candidateId, diff: { sourceCount, rejectedAtSourceCount: c.rejectedAt } });
}

export type CandidateJobResult = 'created' | 'merged' | 'useful' | 'skipped' | 'refused';

const jobInput = z.strictObject({ ticketId: z.uuid() });

/**
 * Задание ai.candidate (решения 26-28). refused: кандидаты выключены, предел исчерпан, обращение не подходит, по нему
 * уже готовился кандидат, модель недоступна или ответила не по схеме. Повтор задания модель второй раз не вызывает.
 */
export async function runCandidateJob(system: SystemActor, data: unknown): Promise<CandidateJobResult> {
  requireSystem(system);
  const { ticketId } = jobInput.parse(data);
  const config = await candidateConfig();
  if (!config.enabled) return 'refused';
  const busy = await withActor(system, async (tx) => (await processedTx(tx, [ticketId])).has(ticketId) || (await callsTodayTx(tx)) >= config.dailyLimit);
  if (busy) return 'refused';
  const ticket = await ticketSolutionSource(system, { ticketId });
  if (!ticket || (ticket.status !== 'resolved' && ticket.status !== 'closed')) return 'refused';
  if ((await ticketsWithSolutionSource(system, [ticketId])).has(ticketId)) return 'refused';
  const authorIds = [ticket.authorId, ...(ticket.assigneeId ? [ticket.assigneeId] : []), ...ticket.messages.flatMap((m) => (m.authorId ? [m.authorId] : []))];
  const profile = await orgAiProfile(system, { orgId: ticket.orgId, userIds: authorIds });
  // Выключенная AI-обработка организации: модель не вызывается вовсе (14.3).
  if (!profile || !profile.isAiEnabled) return 'refused';
  const split = (name: string) => [name, ...name.split(/\s+/)];
  const names = (staffSide: boolean) => profile.people.filter((p) => p.isStaff === staffSide).flatMap((p) => split(p.name));
  const locale = ['ru', 'uz', 'en'].includes(ticket.locale) ? ticket.locale : 'ru';
  const input = assembleDraftData({
    locale,
    title: ticket.title,
    description: ticket.source === 'email' ? stripQuote(ticket.description) : ticket.description,
    messages: ticket.messages.map((m) => ({ role: m.authorType, body: m.body })),
    redaction: { clientNames: [...names(false), ...profile.memberNames.flatMap(split)], staffNames: names(true), orgTerms: [profile.name, ...(profile.inn ? [profile.inn] : [])] },
  });
  let outcome: Awaited<ReturnType<typeof callAi<SolutionDraft>>>;
  try {
    outcome = await callAi(system, { purpose: 'candidate', orgId: ticket.orgId, refId: null, ticketId, system: DRAFT_SYSTEM, data: input, schema: draftSchema, maxTokens: DRAFT_MAX_TOKENS });
  } catch {
    // Сбой записан в журнал вызовов; ответ не по схеме второй раз не запрашивается (итог invalid_response).
    return 'refused';
  }
  if (outcome.status !== 'ok') return 'refused';
  const runId = outcome.runId;
  if (!outcome.value.confident) {
    await withActor(system, (tx) => recordDecisionTx(tx, runId, { decision: 'skipped' }));
    return 'skipped';
  }
  const draft = cleanDraft(outcome.value, await readAllowedDomains());
  const vector = await vectorWithRetries(vectorText(draft));
  if (vector) {
    const published = await nearestPublished(system, { vector });
    const nearest = await withActor(system, (tx) => nearestCandidateTx(tx, vector));
    const decision = candidateMergeDecision({ publishedBest: published, candidateBest: nearest, thresholds: { published: config.publishedSimilarity, merge: config.mergeSimilarity } });
    if (decision.kind === 'useful') {
      // Совпадение без человека считается отдельно от "пригодилось сотрудникам" (волна 7, S-M8; решение 0154).
      await bumpMachineMatch(system, { articleId: decision.articleId });
      return 'useful';
    }
    if (decision.kind === 'merge') {
      const added = await withActor(system, async (tx) => {
        const inserted = await tx.insert(candidateSources).values({ orgId: ticket.orgId, candidateId: decision.candidateId, ticketId }).onConflictDoNothing().returning({ id: candidateSources.sourceId });
        if (inserted.length > 0) await recountTx(tx, decision.candidateId);
        return inserted.length > 0;
      });
      return added ? 'merged' : 'refused';
    }
  } else logEvent('warn', 'ai.candidate_without_vector', { attempts: CANDIDATE_VECTOR_ATTEMPTS });
  const created = await withActor(system, async (tx) => {
    const [row] = await tx
      .insert(solutionCandidates)
      .values({ moduleId: ticket.moduleId, locale, title: draft.title, problem: draft.problem, steps: draft.steps, findings: draft.findings, embedding: vector, status: 'new', sourceCount: 0, orgCount: 0 })
      .returning({ id: solutionCandidates.candidateId });
    const inserted = await tx.insert(candidateSources).values({ orgId: ticket.orgId, candidateId: row!.id, ticketId }).onConflictDoNothing().returning({ id: candidateSources.sourceId });
    if (inserted.length === 0) throw new CandidateRace();
    await recountTx(tx, row!.id);
    return true;
  }).catch((error: unknown) => {
    // Второе задание на то же обращение успело раньше: транзакция откатилась, кандидат один.
    if (error instanceof CandidateRace) return false;
    throw error;
  });
  return created ? 'created' : 'refused';
}

class CandidateRace extends Error {}

/**
 * Ночная задача ai.candidates_embed (решение 28): кандидаты без вектора получают вектор и склеиваются с похожим
 * кандидатом (источники переносятся к ближайшему, опустевший удаляется). Похожий на опубликованное решение остаётся
 * кандидатом: решение о нём за сотрудником. Отклонённый сотрудником кандидат не удаляется: к нему склеиваются другие.
 */
export async function runCandidatesEmbed(system: SystemActor): Promise<{ embedded: number; merged: number }> {
  requireSystem(system);
  const config = await candidateConfig();
  const rows = await withActor(system, (tx) =>
    tx
      .select({ id: solutionCandidates.candidateId, title: solutionCandidates.title, problem: solutionCandidates.problem })
      .from(solutionCandidates)
      .where(and(isNull(solutionCandidates.embedding), eq(solutionCandidates.status, 'new'), isNull(solutionCandidates.decidedBy)))
      .orderBy(solutionCandidates.createdOn)
      .limit(EMBED_MAX),
  );
  let embedded = 0;
  let merged = 0;
  for (const row of rows) {
    const vector = await queryVector(vectorText(row));
    if (!vector) break;
    const joined = await withActor(system, async (tx) => {
      // Между выборкой и склейкой сотрудник мог решить кандидата (принять, объединить, отклонить): строка блокируется и
      // проверяется заново, решённый кандидат задача не трогает.
      const [source] = await tx
        .select({ id: solutionCandidates.candidateId })
        .from(solutionCandidates)
        .where(and(eq(solutionCandidates.candidateId, row.id), eq(solutionCandidates.status, 'new'), isNull(solutionCandidates.decidedBy)))
        .for('update');
      if (!source) return null;
      embedded += 1;
      const nearest = await nearestCandidateTx(tx, vector, row.id);
      if (nearest && nearest.similarity >= config.mergeSimilarity) {
        // Источники переходят к похожему кандидату, опустевший кандидат удаляется (он ещё не решался сотрудником).
        await tx.update(candidateSources).set({ candidateId: nearest.id }).where(eq(candidateSources.candidateId, row.id));
        await tx.delete(solutionCandidates).where(and(eq(solutionCandidates.candidateId, row.id), isNull(solutionCandidates.decidedBy)));
        await recountTx(tx, nearest.id);
        return true;
      }
      await tx.update(solutionCandidates).set({ embedding: vector }).where(eq(solutionCandidates.candidateId, row.id));
      return false;
    });
    if (joined) merged += 1;
  }
  return { embedded, merged };
}
