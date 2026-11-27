import 'server-only';
import { and, desc, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { HdpError } from '../error';
import { ACTIVE_PROBLEM_STATUSES } from '../pref';
import { problems } from '../schema';

// Модуль hdp, слой api: показатели известных проблем для /agent/metrics (ТЗ FR-MET-08; план M5c, задача 11). Видят все
// сотрудники, как остальные показатели. Активные проблемы на сейчас с числом обращений и организаций; исправленные за
// период и среднее время от первого обращения до исправления. Без кеша.

const input = z.strictObject({ from: z.date(), to: z.date() });
const ACTIVE_ROWS = 20;

export type ProblemMetrics = {
  activeCount: number;
  /** Активные проблемы с наибольшим числом обращений, не больше 20. */
  active: { number: number; internalTitle: string; ticketCount: number; orgCount: number }[];
  fixedCount: number;
  /** Среднее время от первого обращения до исправления у исправленных в периоде, часов. */
  averageHoursToFix: number | null;
};

export async function problemMetrics(ctx: StaffContext, value: unknown): Promise<ProblemMetrics> {
  if (ctx.actor.type !== 'staff') throw new HdpError('forbidden');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdpError('invalid_input');
  const { from, to } = parsed.data;
  return withActor(ctx.actor, async (tx) => {
    const activeWhere = inArray(problems.status, [...ACTIVE_PROBLEM_STATUSES]);
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(problems).where(activeWhere);
    const active = await tx
      .select({ number: problems.number, internalTitle: problems.internalTitle, ticketCount: problems.ticketCount, orgCount: problems.orgCount })
      .from(problems)
      .where(activeWhere)
      .orderBy(desc(problems.ticketCount), desc(problems.orgCount), problems.number)
      .limit(ACTIVE_ROWS);
    const [fixed] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        hours: sql<number | null>`avg(extract(epoch from (${problems.fixedOn} - ${problems.firstSeenOn})) / 3600)::float8`,
      })
      .from(problems)
      .where(and(isNotNull(problems.fixedOn), isNotNull(problems.firstSeenOn), gte(problems.fixedOn, from), lt(problems.fixedOn, to)));
    return { activeCount: counted?.n ?? 0, active, fixedCount: fixed?.n ?? 0, averageHoursToFix: fixed?.hours ?? null };
  });
}
