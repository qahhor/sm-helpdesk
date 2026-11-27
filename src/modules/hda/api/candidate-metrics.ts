import 'server-only';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { firstPublishedOn } from '@/modules/hdk/api/similar';
import { KB_WRITER_ROLES } from '@/modules/hdk/pref';
import { HdaError } from '../error';
import { solutionCandidates } from '../schema';

// Модуль hda, слой api: показатели кандидатов в решения для /agent/metrics (ТЗ FR-MET-09, FR-CAND-08; план M5c,
// задача 11). Кандидатов видят роли с правом черновика решения, у остальных блока нет. Создано в периоде; принято,
// объединено и отклонено решениями периода; среднее время от появления кандидата до публикации решения из него.

const input = z.strictObject({ from: z.date(), to: z.date() });

export type CandidateMetrics = { created: number; accepted: number; merged: number; rejected: number; averageHoursToPublish: number | null };

export const canSeeCandidateMetrics = (ctx: StaffContext): boolean => ctx.actor.type === 'staff' && (KB_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole);

export async function candidateMetrics(ctx: StaffContext, value: unknown): Promise<CandidateMetrics> {
  if (!canSeeCandidateMetrics(ctx)) throw new HdaError('forbidden');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdaError('invalid_input');
  const { from, to } = parsed.data;
  const decidedIn = (status: 'accepted' | 'merged' | 'rejected') => sql<number>`(count(*) filter (where ${solutionCandidates.status} = ${status} and ${solutionCandidates.decidedOn} >= ${from.toISOString()}::timestamptz and ${solutionCandidates.decidedOn} < ${to.toISOString()}::timestamptz))::int`;
  const { counts, accepted } = await withActor(ctx.actor, async (tx) => {
    const [counts] = await tx
      .select({
        created: sql<number>`(count(*) filter (where ${solutionCandidates.createdOn} >= ${from.toISOString()}::timestamptz and ${solutionCandidates.createdOn} < ${to.toISOString()}::timestamptz))::int`,
        accepted: decidedIn('accepted'),
        merged: decidedIn('merged'),
        rejected: decidedIn('rejected'),
      })
      .from(solutionCandidates)
      .where(sql`${solutionCandidates.createdOn} < ${to.toISOString()}::timestamptz`);
    const accepted = await tx
      .select({ articleId: solutionCandidates.articleId, createdOn: solutionCandidates.createdOn })
      .from(solutionCandidates)
      .where(and(eq(solutionCandidates.status, 'accepted'), isNotNull(solutionCandidates.articleId), gte(solutionCandidates.createdOn, from), lt(solutionCandidates.createdOn, to)));
    return { counts, accepted };
  });
  const published = await firstPublishedOn(ctx.actor, accepted.flatMap((a) => (a.articleId ? [a.articleId] : [])));
  const hours = accepted.flatMap((a) => {
    const on = a.articleId ? published.get(a.articleId) : undefined;
    return on && on >= a.createdOn ? [(on.getTime() - a.createdOn.getTime()) / 3_600_000] : [];
  });
  return {
    created: counts?.created ?? 0,
    accepted: counts?.accepted ?? 0,
    merged: counts?.merged ?? 0,
    rejected: counts?.rejected ?? 0,
    averageHoursToPublish: hours.length > 0 ? hours.reduce((a, b) => a + b, 0) / hours.length : null,
  };
}
