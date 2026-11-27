import 'server-only';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { AI_DAY_TIME_ZONE, TRIAGE_APPLIED_FIELDS, TRIAGE_REVIEW_MIN, TRIAGE_REVIEW_SHARE, type TriageField, type TriageStatus } from '../pref';
import { aiRuns, aiTriageFieldOffs, aiTriageSuggestions, type FoundRef } from '../schema';

// Модуль hda, слой core: предложения разбора (план M5b, задача 7, решение 18; FR-TRI-01..06). Пишет система после
// проверки кодом, решает сотрудник, читает сотрудник. Клиент таблицу не видит (политики миграции 0093).

export type SuggestionRow = { suggestionId: string; field: TriageField; value: string; status: TriageStatus; decidedOn: Date | null };

/** Предложения записываются один раз на поле и обращение: повторный ответ помощника нового предложения не даёт. */
export async function insertSuggestionsTx(tx: Tx, input: { orgId: string; ticketId: string; runId: string; items: { field: TriageField; value: string }[] }): Promise<number> {
  if (input.items.length === 0) return 0;
  const rows = await tx
    .insert(aiTriageSuggestions)
    .values(input.items.map((item) => ({ orgId: input.orgId, ticketId: input.ticketId, runId: input.runId, field: item.field, value: item.value })))
    .onConflictDoNothing()
    .returning({ id: aiTriageSuggestions.suggestionId });
  return rows.length;
}

export async function hasSuggestionsTx(tx: Tx, ticketId: string): Promise<boolean> {
  const rows = await tx.select({ id: aiTriageSuggestions.suggestionId }).from(aiTriageSuggestions).where(eq(aiTriageSuggestions.ticketId, ticketId)).limit(1);
  return rows.length > 0;
}

export async function suggestionsTx(tx: Tx, ticketId: string, opts: { lock?: boolean } = {}): Promise<SuggestionRow[]> {
  const query = tx
    .select({ suggestionId: aiTriageSuggestions.suggestionId, field: aiTriageSuggestions.field, value: aiTriageSuggestions.value, status: aiTriageSuggestions.status, decidedOn: aiTriageSuggestions.decidedOn })
    .from(aiTriageSuggestions)
    .where(eq(aiTriageSuggestions.ticketId, ticketId))
    .orderBy(asc(aiTriageSuggestions.field));
  return opts.lock ? query.for('update') : query;
}

export async function markSuggestionsTx(tx: Tx, ids: readonly string[], status: Exclude<TriageStatus, 'pending'>, userId: string, now: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(aiTriageSuggestions)
    .set({ status, decidedBy: userId, decidedOn: now })
    .where(and(inArray(aiTriageSuggestions.suggestionId, [...ids]), eq(aiTriageSuggestions.status, 'pending')));
}

/** Поля, которые ночная задача отключила и администратор ещё не включил обратно (FR-TRI-04). */
export async function activeFieldOffsTx(tx: Tx): Promise<{ offId: string; field: TriageField; share: number; decisions: number; createdOn: Date }[]> {
  const rows = await tx
    .select({ offId: aiTriageFieldOffs.offId, field: aiTriageFieldOffs.field, share: aiTriageFieldOffs.share, decisions: aiTriageFieldOffs.decisions, createdOn: aiTriageFieldOffs.createdOn })
    .from(aiTriageFieldOffs)
    .where(isNull(aiTriageFieldOffs.liftedOn));
  return rows.map((r) => ({ ...r, share: Number(r.share) }));
}

/** Предложение без решения дольше этого считается непринятым в доле FR-TRI-04: сотрудник прошёл мимо. */
const IGNORED_AFTER_DAYS = 7;

/**
 * Доля принятых по полю за календарный месяц момента now (по Ташкенту): принятые к решённым, где решённым считается
 * принятое, отклонённое и ждущее дольше 7 дней. Поле ниже 70% при не менее чем 30 решениях отключается, если в этом
 * месяце его ещё не отключали (снятое администратором отключение ночь не возвращает). Возвращает отключённые поля.
 */
export async function reviewFieldsTx(tx: Tx, now: Date): Promise<TriageField[]> {
  const month = sql<string>`date_trunc('month', ${now.toISOString()}::timestamptz at time zone ${AI_DAY_TIME_ZONE})::date`;
  const from = sql`date_trunc('month', ${now.toISOString()}::timestamptz at time zone ${AI_DAY_TIME_ZONE}) at time zone ${AI_DAY_TIME_ZONE}`;
  const ignoredBefore = new Date(now.getTime() - IGNORED_AFTER_DAYS * 86_400_000);
  const rows = await tx
    .select({
      field: aiTriageSuggestions.field,
      decided: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${aiTriageSuggestions.status} = 'accepted')::int`,
    })
    .from(aiTriageSuggestions)
    .where(
      and(
        gte(aiTriageSuggestions.createdOn, from),
        lt(aiTriageSuggestions.createdOn, now),
        or(isNotNull(aiTriageSuggestions.decidedOn), lt(aiTriageSuggestions.createdOn, ignoredBefore)),
      ),
    )
    .groupBy(aiTriageSuggestions.field);
  const off: TriageField[] = [];
  for (const row of rows) {
    // Резюме и пометка приоритета только показываются сотруднику: их "принятие" ничего не меняет в обращении, доля
    // принятых у них не говорит о качестве (долг M5b M7, план M5c, задача 11).
    if (!(TRIAGE_APPLIED_FIELDS as readonly string[]).includes(row.field) || row.decided < TRIAGE_REVIEW_MIN) continue;
    const share = row.accepted / row.decided;
    if (share >= TRIAGE_REVIEW_SHARE) continue;
    const inserted = await tx
      .insert(aiTriageFieldOffs)
      .values({ field: row.field, month, share: share.toFixed(4), decisions: row.decided })
      .onConflictDoNothing()
      .returning({ id: aiTriageFieldOffs.offId });
    if (inserted.length > 0) off.push(row.field);
  }
  return off.sort();
}

export async function liftFieldOffTx(tx: Tx, offId: string, userId: string): Promise<{ field: TriageField } | null> {
  const [row] = await tx
    .update(aiTriageFieldOffs)
    .set({ liftedOn: new Date(), liftedBy: userId })
    .where(and(eq(aiTriageFieldOffs.offId, offId), isNull(aiTriageFieldOffs.liftedOn)))
    .returning({ field: aiTriageFieldOffs.field });
  return row ?? null;
}

/** Найденные решения последнего вызова первой линии по обращению, где они записаны. */
export async function latestFoundTx(tx: Tx, ticketId: string): Promise<FoundRef[]> {
  const [row] = await tx
    .select({ found: aiRuns.found })
    .from(aiRuns)
    .where(and(eq(aiRuns.ticketId, ticketId), isNotNull(aiRuns.found)))
    .orderBy(desc(aiRuns.createdOn))
    .limit(1);
  return row?.found ?? [];
}

export async function recordFoundTx(tx: Tx, runId: string, found: FoundRef[]): Promise<void> {
  await tx.update(aiRuns).set({ found: found.slice(0, 3) }).where(eq(aiRuns.runId, runId));
}
