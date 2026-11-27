import 'server-only';
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { AI_DAY_TIME_ZONE, AI_USER_LIMIT_PURPOSES, AI_REPEAT_HOURS, type AiDecision, type AiHandoffReason, type AiOutcome, type AiPurpose } from '../pref';
import { aiOrgCutoffs, aiRuns } from '../schema';

// Модуль hda, слой core: журнал вызовов модели (план M5, задача 5, решения 2 и 13; план M5b, задача 1, решения 11, 12).
// Работает под системным актором: пишет только фоновый процесс. Текста запроса и ответа здесь нет (поправка 101).

export type RunRow = {
  orgId: string | null;
  refId: string | null;
  purpose: AiPurpose;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: AiOutcome;
  errorCode: string | null;
  ticketId?: string | null;
  userId?: string | null;
  inputHash?: string | null;
};

export async function insertRunTx(tx: Tx, row: RunRow): Promise<string> {
  const [inserted] = await tx
    .insert(aiRuns)
    .values({ ...row, costUsd: row.costUsd.toFixed(6) })
    .returning({ runId: aiRuns.runId });
  return inserted!.runId;
}

/** Начало текущих суток и месяца по Ташкенту (как суточный предел M5). */
const dayStart = sql`date_trunc('day', now() at time zone ${AI_DAY_TIME_ZONE}) at time zone ${AI_DAY_TIME_ZONE}`;
const monthStart = sql`date_trunc('month', now() at time zone ${AI_DAY_TIME_ZONE}) at time zone ${AI_DAY_TIME_ZONE}`;
/** Первое число текущего месяца по Ташкенту датой: ключ отключения. */
export const currentMonth = sql<string>`date_trunc('month', now() at time zone ${AI_DAY_TIME_ZONE})::date`;
/** Вызовом считается строка, где модель могла быть вызвана: отказ по пределу и повтор не считаются. */
const NOT_CALLS: AiOutcome[] = ['limited', 'repeated'];

/** Вызовы модели за текущие сутки по Ташкенту на черновики и переводы (решение 13 M5). Первая линия считается отдельно. */
export async function callsTodayTx(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(and(gte(aiRuns.createdOn, dayStart), notInArray(aiRuns.outcome, NOT_CALLS), notInArray(aiRuns.purpose, [...AI_USER_LIMIT_PURPOSES])));
  return row?.count ?? 0;
}

/** Вызовы целей с пределом пользователя за сутки по Ташкенту: у пользователя и у организации (решение 11). */
export async function firstLineCallsTodayTx(tx: Tx, who: { userId: string | null; orgId: string | null }): Promise<{ user: number; org: number }> {
  const base = and(gte(aiRuns.createdOn, dayStart), notInArray(aiRuns.outcome, NOT_CALLS), inArray(aiRuns.purpose, [...AI_USER_LIMIT_PURPOSES]));
  const count = async (where: ReturnType<typeof and>) => (await tx.select({ count: sql<number>`count(*)::int` }).from(aiRuns).where(where))[0]?.count ?? 0;
  return {
    user: who.userId ? await count(and(base, eq(aiRuns.userId, who.userId))) : 0,
    org: who.orgId ? await count(and(base, eq(aiRuns.orgId, who.orgId))) : 0,
  };
}

/** Сколько раз модель уточняла благодарность в обращении за сутки по Ташкенту (отказ по пределу не считается). */
export async function thanksCallsTodayTx(tx: Tx, ticketId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(and(eq(aiRuns.ticketId, ticketId), eq(aiRuns.purpose, 'thanks'), gte(aiRuns.createdOn, dayStart), notInArray(aiRuns.outcome, NOT_CALLS)));
  return row?.count ?? 0;
}

/** Расход за текущий месяц по Ташкенту: всего и по организациям (все цели вместе, решение 11). */
export async function monthSpendTx(tx: Tx): Promise<{ total: number; byOrg: { orgId: string; usd: number }[] }> {
  const rows = await tx
    .select({ orgId: aiRuns.orgId, usd: sql<string>`sum(${aiRuns.costUsd})` })
    .from(aiRuns)
    .where(gte(aiRuns.createdOn, monthStart))
    .groupBy(aiRuns.orgId);
  const byOrg = rows.flatMap((r) => (r.orgId ? [{ orgId: r.orgId, usd: Number(r.usd) }] : []));
  return { total: rows.reduce((sum, r) => sum + Number(r.usd), 0), byOrg };
}

/** Действующие отключения этого месяца: всех (null) или организации. */
export async function activeCutoffTx(tx: Tx, orgId: string | null): Promise<'all' | 'org' | null> {
  const rows = await tx
    .select({ orgId: aiOrgCutoffs.orgId })
    .from(aiOrgCutoffs)
    .where(and(eq(aiOrgCutoffs.month, currentMonth), isNull(aiOrgCutoffs.liftedOn)));
  if (rows.some((r) => r.orgId === null)) return 'all';
  return orgId && rows.some((r) => r.orgId === orgId) ? 'org' : null;
}

/** Отключение ставится один раз на организацию и месяц: true, если строка новая. */
export async function insertCutoffTx(tx: Tx, orgId: string | null): Promise<boolean> {
  const inserted = await tx
    .insert(aiOrgCutoffs)
    .values({ orgId, month: currentMonth, reason: orgId ? 'budget_share' : 'budget_total' })
    .onConflictDoNothing()
    .returning({ id: aiOrgCutoffs.cutoffId });
  return inserted.length > 0;
}

export type PriorRun = { runId: string; decision: AiDecision | null; solutionId: string | null; handoffReason: AiHandoffReason | null };

/**
 * Прошлый удачный вызов с тем же входом в той же организации за 24 часа (решение 12): его выбор повторяется без
 * модели. Учитываются вызовы с итогом ok и решённым действием.
 */
export async function priorRunTx(tx: Tx, input: { orgId: string; purpose: AiPurpose; inputHash: string }): Promise<PriorRun | null> {
  const [row] = await tx
    .select({ runId: aiRuns.runId, decision: aiRuns.decision, solutionId: aiRuns.solutionId, handoffReason: aiRuns.handoffReason })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.orgId, input.orgId),
        eq(aiRuns.inputHash, input.inputHash),
        eq(aiRuns.purpose, input.purpose),
        eq(aiRuns.outcome, 'ok'),
        gte(aiRuns.createdOn, sql`now() - make_interval(hours => ${AI_REPEAT_HOURS})`),
        isNotNull(aiRuns.decision),
      ),
    )
    .orderBy(sql`${aiRuns.createdOn} desc`)
    .limit(1);
  return row ?? null;
}

/** Решение кода по вызову: та же строка журнала (решение 13). */
export async function recordDecisionTx(
  tx: Tx,
  runId: string,
  decision: { decision: AiDecision; handoffReason?: AiHandoffReason | null; solutionId?: string | null; confidence?: number | null },
): Promise<void> {
  await tx
    .update(aiRuns)
    .set({
      decision: decision.decision,
      handoffReason: decision.handoffReason ?? null,
      solutionId: decision.solutionId ?? null,
      confidence: decision.confidence === null || decision.confidence === undefined || !Number.isFinite(decision.confidence) ? null : decision.confidence.toFixed(6),
    })
    .where(eq(aiRuns.runId, runId));
}
