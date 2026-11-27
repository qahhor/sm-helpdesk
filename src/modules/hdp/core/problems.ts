import 'server-only';
import { and, asc, desc, eq, inArray, isNotNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { containsText } from '@/db/contains';
import type { Tx } from '@/db/client';
import type { Locale } from '@/i18n/locales';
import { HdpError } from '../error';
import { ACTIVE_PROBLEM_STATUSES, type ProblemStatus } from '../pref';
import { problems, problemSignatures, problemTranslations } from '../schema';
import type { ProblemRow } from '../types';
import { parseProblemRef, pgErrorCode } from '../util';

// Модуль hdp, слой core: известные проблемы в базе (план M5c, задача 2). Права проверяют слой api и политики базы;
// счётчики и моменты появления ставит триггер t_hdp_problems_guard.

export type ProblemHead = {
  problemId: string;
  number: number;
  internalTitle: string;
  status: ProblemStatus;
  moduleId: string | null;
  workaroundSolutionId: string | null;
  ownerId: string | null;
  sourceLocale: Locale;
  showToClients: boolean;
  ticketCount: number;
  orgCount: number;
  firstSeenOn: Date | null;
  lastSeenOn: Date | null;
  fixedOn: Date | null;
  closedOn: Date | null;
};

const head = {
  problemId: problems.problemId,
  number: problems.number,
  internalTitle: problems.internalTitle,
  status: problems.status,
  moduleId: problems.moduleId,
  workaroundSolutionId: problems.workaroundSolutionId,
  ownerId: problems.ownerId,
  sourceLocale: problems.sourceLocale,
  showToClients: problems.showToClients,
  ticketCount: problems.ticketCount,
  orgCount: problems.orgCount,
  firstSeenOn: problems.firstSeenOn,
  lastSeenOn: problems.lastSeenOn,
  fixedOn: problems.fixedOn,
  closedOn: problems.closedOn,
};

/** Проблема по номеру или идентификатору; lock: под блокировкой строки (после блокировки обращения). */
export async function problemTx(tx: Tx, key: { number: number } | { problemId: string }, opts: { lock?: boolean } = {}): Promise<ProblemHead | null> {
  const query = tx
    .select(head)
    .from(problems)
    .where('number' in key ? eq(problems.number, key.number) : eq(problems.problemId, key.problemId))
    .limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  return row ?? null;
}

export async function requireProblemTx(tx: Tx, key: { number: number } | { problemId: string }, opts: { lock?: boolean } = {}): Promise<ProblemHead> {
  const row = await problemTx(tx, key, opts);
  if (!row) throw new HdpError('not_found');
  return row;
}

export async function insertProblemTx(
  tx: Tx,
  values: { internalTitle: string; moduleId: string | null; ownerId: string | null; sourceLocale?: Locale },
): Promise<{ problemId: string; number: number }> {
  const [row] = await tx
    .insert(problems)
    .values({ internalTitle: values.internalTitle, moduleId: values.moduleId, ownerId: values.ownerId, sourceLocale: values.sourceLocale ?? 'ru' })
    .returning({ problemId: problems.problemId, number: problems.number });
  return row!;
}

export async function updateProblemTx(
  tx: Tx,
  problemId: string,
  set: Partial<{ internalTitle: string; moduleId: string | null; workaroundSolutionId: string | null; status: ProblemStatus; showToClients: boolean; sourceLocale: Locale }>,
): Promise<void> {
  await tx.update(problems).set(set).where(eq(problems.problemId, problemId));
}

/**
 * Пересчёт счётчиков проблемы после привязки или отвязки обращения в той же транзакции (решение 9). Значение
 * ставит триггер базы по привязанным обращениям; присвоение здесь лишь вызывает его.
 */
export async function recountProblemTx(tx: Tx, problemId: string): Promise<void> {
  await tx
    .update(problems)
    .set({ ticketCount: sql`${problems.ticketCount}` })
    .where(eq(problems.problemId, problemId));
}

export type TranslationRow = { locale: Locale; publicTitle: string; publicBody: string; isMachine: boolean; acceptedBy: string | null };

export async function translationsTx(tx: Tx, problemId: string): Promise<TranslationRow[]> {
  return tx
    .select({ locale: problemTranslations.locale, publicTitle: problemTranslations.publicTitle, publicBody: problemTranslations.publicBody, isMachine: problemTranslations.isMachine, acceptedBy: problemTranslations.acceptedBy })
    .from(problemTranslations)
    .where(eq(problemTranslations.problemId, problemId))
    .orderBy(asc(problemTranslations.locale));
}

/** Текст сотрудника (isMachine false) или машинный (принятый сотрудником или нет). */
export async function upsertTranslationTx(
  tx: Tx,
  row: { problemId: string; locale: Locale; publicTitle: string; publicBody: string; isMachine: boolean; acceptedBy: string | null },
): Promise<void> {
  const values = {
    publicTitle: row.publicTitle,
    publicBody: row.publicBody,
    isMachine: row.isMachine,
    acceptedBy: row.acceptedBy,
    acceptedOn: row.acceptedBy ? sql`now()` : null,
  };
  await tx
    .insert(problemTranslations)
    .values({ problemId: row.problemId, locale: row.locale, ...values })
    .onConflictDoUpdate({ target: [problemTranslations.problemId, problemTranslations.locale], set: values });
}

/**
 * Текст оригинала изменился (решение 0109): принятые машинные переводы на другие языки устарели. Принятие снимается,
 * текст перевода остаётся сотруднику для сверки; клиенту он больше не виден, и клиент получает текст оригинала (или
 * свежий перевод, когда сотрудник его примет). Тексты сотрудника на других языках не трогаются. Возвращает языки.
 */
export async function unacceptMachineTranslationsTx(tx: Tx, problemId: string, sourceLocale: Locale): Promise<Locale[]> {
  const rows = await tx
    .update(problemTranslations)
    .set({ acceptedBy: null, acceptedOn: null })
    .where(and(eq(problemTranslations.problemId, problemId), eq(problemTranslations.isMachine, true), isNotNull(problemTranslations.acceptedBy), ne(problemTranslations.locale, sourceLocale)))
    .returning({ locale: problemTranslations.locale });
  return rows.map((r) => r.locale).sort();
}

/** Виден ли текст клиенту: название и описание есть, текст сотрудника или принятый перевод (как в hdp_problems_public). */
export const isPublishedText = (t: TranslationRow): boolean => t.publicTitle.trim() !== '' && t.publicBody.trim() !== '' && (!t.isMachine || t.acceptedBy !== null);

export async function signaturesTx(tx: Tx, problemId: string): Promise<{ signature: string; isActive: boolean }[]> {
  return tx
    .select({ signature: problemSignatures.signature, isActive: problemSignatures.isActive })
    .from(problemSignatures)
    .where(eq(problemSignatures.problemId, problemId))
    .orderBy(asc(problemSignatures.createdOn), asc(problemSignatures.signature));
}

/** Добавить сигнатуру; занята другой активной проблемой: signature_taken (частичный уникальный индекс, решение 7). */
export async function insertSignatureTx(tx: Tx, row: { problemId: string; signature: string; addedBy: string | null }): Promise<boolean> {
  try {
    const inserted = await tx.insert(problemSignatures).values(row).onConflictDoNothing({ target: [problemSignatures.problemId, problemSignatures.signature] }).returning({ signature: problemSignatures.signature });
    return inserted.length > 0;
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new HdpError('signature_taken');
    throw error;
  }
}

export async function deleteSignatureTx(tx: Tx, problemId: string, signature: string): Promise<boolean> {
  const rows = await tx
    .delete(problemSignatures)
    .where(and(eq(problemSignatures.problemId, problemId), eq(problemSignatures.signature, signature)))
    .returning({ signature: problemSignatures.signature });
  return rows.length > 0;
}

/** Активная проблема с этой сигнатурой (привязка по сигнатуре, решение 8); нет: null. */
export async function activeProblemBySignatureTx(tx: Tx, signature: string): Promise<{ problemId: string; number: number } | null> {
  const [row] = await tx
    .select({ problemId: problems.problemId, number: problems.number })
    .from(problemSignatures)
    .innerJoin(problems, eq(problems.problemId, problemSignatures.problemId))
    .where(and(eq(problemSignatures.signature, signature), eq(problemSignatures.isActive, true), inArray(problems.status, [...ACTIVE_PROBLEM_STATUSES])))
    .limit(1);
  return row ?? null;
}

const LIST_LIMIT = 200;

/** Список проблем у сотрудника (FR-ADM-12): открытые сверху по последнему появлению; поиск по номеру и названию. */
export async function listProblemsTx(tx: Tx, filter: { status?: ProblemStatus | 'active'; moduleId?: string; q?: string }): Promise<ProblemRow[]> {
  const where: SQL[] = [];
  if (filter.status === 'active') where.push(inArray(problems.status, [...ACTIVE_PROBLEM_STATUSES]));
  else if (filter.status) where.push(eq(problems.status, filter.status));
  if (filter.moduleId) where.push(eq(problems.moduleId, filter.moduleId));
  const q = filter.q?.trim();
  if (q) {
    const ref = parseProblemRef(q);
    where.push(ref ? or(eq(problems.number, ref), containsText(problems.internalTitle, q))! : containsText(problems.internalTitle, q));
  }
  return tx
    .select({
      problemId: problems.problemId,
      number: problems.number,
      internalTitle: problems.internalTitle,
      status: problems.status,
      moduleId: problems.moduleId,
      showToClients: problems.showToClients,
      ticketCount: problems.ticketCount,
      orgCount: problems.orgCount,
      firstSeenOn: problems.firstSeenOn,
      lastSeenOn: problems.lastSeenOn,
    })
    .from(problems)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(sql`case when ${problems.status} in ('fixed', 'closed') then 1 else 0 end`, desc(sql`coalesce(${problems.lastSeenOn}, ${problems.createdOn})`), desc(problems.number))
    .limit(LIST_LIMIT);
}
