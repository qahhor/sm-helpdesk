import 'server-only';
import { and, gte, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { AI_DAY_TIME_ZONE, type AiOutcome, type AiPurpose } from '../pref';
import { aiRuns } from '../schema';

// Модуль hda, слой core: журнал вызовов модели (план M5, задача 5, решения 2 и 13). Работает под системным актором:
// пишет только фоновый процесс. Текста запроса и ответа здесь нет (поправка 101).

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
};

export async function insertRunTx(tx: Tx, row: RunRow): Promise<void> {
  await tx.insert(aiRuns).values({ ...row, costUsd: row.costUsd.toFixed(6) });
}

/** Вызовы модели за текущие сутки по Ташкенту. Отказы по пределу вызовами не считаются. */
export async function callsTodayTx(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(
      and(
        gte(aiRuns.createdOn, sql`date_trunc('day', now() at time zone ${AI_DAY_TIME_ZONE}) at time zone ${AI_DAY_TIME_ZONE}`),
        ne(aiRuns.outcome, 'limited'),
      ),
    );
  return row?.count ?? 0;
}
