import 'server-only';
import { and, gte, inArray, isNotNull, lt, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { monthSpendTx } from '../core/runs';
import { HdaError } from '../error';
import { aiRuns } from '../schema';

// Модуль hda, слой api: показатели помощника по журналу вызовов (план M5b, задача 10; FR-MET-06, FR-AI-16, FR-SOL-19).
// Ответы решением и отмеченные неверными за период (индекс hda_runs_i10), расход за текущий месяц по Ташкенту,
// сколько раз помощник ответил каждым решением (индекс hda_runs_i9). Только сотрудники.

function requireStaff(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff') throw new HdaError('forbidden');
}

export type AssistantRunStats = { answers: number; flagged: number; flaggedPercent: number | null; spentMonthUsd: number };

export async function assistantRunStats(ctx: StaffContext, range: { from: Date; to: Date }): Promise<AssistantRunStats> {
  requireStaff(ctx);
  const parsed = z.strictObject({ from: z.date(), to: z.date() }).safeParse(range);
  if (!parsed.success) throw new HdaError('invalid_input');
  return withActor(ctx.actor, async (tx) => {
    const [row] = await tx
      .select({
        answers: sql<number>`count(*) filter (where ${aiRuns.decision} = 'answer')::int`,
        flagged: sql<number>`count(*) filter (where ${aiRuns.decision} = 'answer' and ${aiRuns.flaggedBy} is not null)::int`,
      })
      .from(aiRuns)
      .where(and(isNotNull(aiRuns.decision), gte(aiRuns.createdOn, parsed.data.from), lt(aiRuns.createdOn, parsed.data.to)));
    const answers = row?.answers ?? 0;
    const flagged = row?.flagged ?? 0;
    const spend = await monthSpendTx(tx);
    return { answers, flagged, flaggedPercent: answers > 0 ? (flagged / answers) * 100 : null, spentMonthUsd: Math.round(spend.total * 1e6) / 1e6 };
  });
}

/** Сколько раз помощник ответил каждым решением (FR-SOL-19): по идентификатору статьи. Нет ответов: ключа нет. */
export async function assistantUseCounts(ctx: StaffContext, articleIds: readonly string[]): Promise<Map<string, number>> {
  requireStaff(ctx);
  const ids = z.array(z.uuid()).max(500).parse([...new Set(articleIds)]);
  if (ids.length === 0) return new Map();
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select({ solutionId: aiRuns.solutionId, count: sql<number>`count(*)::int` })
      .from(aiRuns)
      .where(and(eq(aiRuns.decision, 'answer'), inArray(aiRuns.solutionId, ids)))
      .groupBy(aiRuns.solutionId),
  );
  return new Map(rows.flatMap((r) => (r.solutionId ? [[r.solutionId, r.count] as const] : [])));
}
