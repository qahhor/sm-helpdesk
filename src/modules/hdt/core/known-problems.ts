import 'server-only';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { HdtError } from '../error';
import type { TicketStatus } from '../pref';
import { ticketEvents, tickets } from '../schema';

// Модуль hdt, слой core: обращение и известная проблема (план M5c, задачи 2 и 3, решения 8, 9). Проблемы ведёт модуль
// hdp; модуль обращений даёт ему узкие функции внутри его транзакции: заблокировать обращение, поставить или снять
// ссылку на проблему с событием истории, прочитать обращения проблемы. Таблицы обращений модуль hdp сам не пишет.

export type ProblemTicket = {
  ticketId: string;
  orgId: string;
  number: number;
  title: string;
  description: string;
  moduleId: string | null;
  errorSignature: string | null;
  status: TicketStatus;
  mergedIntoId: string | null;
  knownProblemId: string | null;
  createdOn: Date;
};

const columns = {
  ticketId: tickets.ticketId,
  orgId: tickets.orgId,
  number: tickets.number,
  title: tickets.title,
  description: tickets.description,
  moduleId: tickets.moduleId,
  errorSignature: tickets.errorSignature,
  status: tickets.status,
  mergedIntoId: tickets.mergedIntoId,
  knownProblemId: tickets.knownProblemId,
  createdOn: tickets.createdOn,
};

/** Обращение по номеру или идентификатору под блокировкой строки. Нет обращения: not_found. */
export async function lockProblemTicketTx(tx: Tx, key: { number: number } | { ticketId: string }): Promise<ProblemTicket> {
  const [row] = await tx
    .select(columns)
    .from(tickets)
    .where('number' in key ? eq(tickets.number, key.number) : eq(tickets.ticketId, key.ticketId))
    .limit(1)
    .for('update');
  if (!row) throw new HdtError('not_found');
  return row;
}

/** То же без блокировки: показ блока проблемы в обращении. Нет обращения: null. */
export async function problemTicketTx(tx: Tx, key: { number: number } | { ticketId: string }): Promise<ProblemTicket | null> {
  const [row] = await tx
    .select(columns)
    .from(tickets)
    .where('number' in key ? eq(tickets.number, key.number) : eq(tickets.ticketId, key.ticketId))
    .limit(1);
  return row ?? null;
}

export type ProblemLinkVia = 'created' | 'manual' | 'bulk' | 'signature' | 'rule' | 'affected';

/**
 * Ссылка обращения на проблему и внутреннее событие истории known_problem (решение 9). Проверки (одна проблема,
 * закрытое обращение) делает вызывающий под блокировкой обращения.
 */
export async function setTicketProblemTx(
  tx: Tx,
  actor: StaffActor | SystemActor,
  ticket: Pick<ProblemTicket, 'ticketId' | 'orgId'>,
  change: { problemId: string | null; problemNumber: number; via: ProblemLinkVia },
): Promise<void> {
  await tx.update(tickets).set({ knownProblemId: change.problemId }).where(eq(tickets.ticketId, ticket.ticketId));
  await tx.insert(ticketEvents).values({
    orgId: ticket.orgId,
    ticketId: ticket.ticketId,
    kind: 'known_problem',
    actorType: actor.type === 'staff' ? 'staff' : 'system',
    actorId: actor.type === 'staff' ? actor.userId : null,
    payload: { action: change.problemId ? 'linked' : 'unlinked', problemNumber: change.problemNumber, via: change.via },
    isInternal: true,
  });
}

export type ProblemTicketRow = { ticketId: string; orgId: string; number: number; title: string; status: TicketStatus; locale: string; createdOn: Date; mergedIntoId: string | null };

/** Обращения проблемы для карточки и рассылки, новые сверху. Объединённые не считаются отдельными (они закрыты навсегда). */
export async function problemTicketsTx(tx: Tx, problemId: string, opts: { limit?: number } = {}): Promise<ProblemTicketRow[]> {
  return tx
    .select({ ticketId: tickets.ticketId, orgId: tickets.orgId, number: tickets.number, title: tickets.title, status: tickets.status, locale: tickets.locale, createdOn: tickets.createdOn, mergedIntoId: tickets.mergedIntoId })
    .from(tickets)
    .where(eq(tickets.knownProblemId, problemId))
    .orderBy(sql`${tickets.createdOn} desc`, asc(tickets.number))
    .limit(opts.limit ?? 5000);
}

/** Сигнатуры привязанных обращений с числом обращений: из них сотрудник добавляет сигнатуру проблеме (раздел 8.12). */
export async function problemTicketSignaturesTx(tx: Tx, problemId: string): Promise<{ signature: string; ticketCount: number }[]> {
  const rows = await tx
    .select({ signature: tickets.errorSignature, ticketCount: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.knownProblemId, problemId), sql`${tickets.errorSignature} is not null`))
    .groupBy(tickets.errorSignature);
  return rows.filter((r): r is { signature: string; ticketCount: number } => r.signature !== null);
}

/** Число обращений по каждой сигнатуре среди привязанных к проблеме. */
export async function signatureTicketCountsTx(tx: Tx, problemId: string, signatures: readonly string[]): Promise<Map<string, number>> {
  if (signatures.length === 0) return new Map();
  const rows = await tx
    .select({ signature: tickets.errorSignature, count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.knownProblemId, problemId), inArray(tickets.errorSignature, [...signatures])))
    .groupBy(tickets.errorSignature);
  return new Map(rows.map((r) => [r.signature ?? '', r.count]));
}

/** Организации обращений проблемы (для проверки публичного текста на названия и ИНН, решение 6). */
export async function problemOrgIdsTx(tx: Tx, problemId: string): Promise<string[]> {
  const rows = await tx.selectDistinct({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.knownProblemId, problemId));
  return rows.map((r) => r.orgId);
}

/** Обращения без проблемы по идентификаторам (черновик проблемы AI-сотрудника): только существующие. */
export async function unlinkedTicketIdsTx(tx: Tx, ticketIds: readonly string[]): Promise<string[]> {
  if (ticketIds.length === 0) return [];
  const rows = await tx.select({ ticketId: tickets.ticketId }).from(tickets).where(and(inArray(tickets.ticketId, [...ticketIds]), isNull(tickets.knownProblemId)));
  return rows.map((r) => r.ticketId);
}

/**
 * Своё обращение клиента по проблеме (план M5c, решение 14): второе нажатие "Меня это тоже затронуло" показывает его
 * номер. Читается от имени клиента: чужое и невидимое обращение политика не отдаёт.
 */
export async function ownProblemTicketTx(tx: Tx, input: { authorId: string; problemId: string }): Promise<number | null> {
  const [row] = await tx
    .select({ number: tickets.number })
    .from(tickets)
    .where(and(eq(tickets.authorId, input.authorId), eq(tickets.knownProblemId, input.problemId)))
    .orderBy(asc(tickets.number))
    .limit(1);
  return row?.number ?? null;
}

/**
 * Сигнатуры обращений за окно с числом разных организаций и обращений (веха M8b, всплеск сигнатуры, решение 25).
 * Объединённые обращения и служебная организация не считаются. Только сигнатуры не меньше чем minOrgs организаций.
 */
export async function signatureOrgCountsTx(
  tx: Tx,
  input: { since: Date; until: Date; minOrgs: number; excludeOrgId: string },
): Promise<{ signature: string; orgCount: number; ticketCount: number }[]> {
  const rows = await tx
    .select({
      signature: sql<string>`${tickets.errorSignature}`,
      orgCount: sql<number>`count(distinct ${tickets.orgId})::int`,
      ticketCount: sql<number>`count(*)::int`,
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.errorSignature} is not null`,
        sql`${tickets.createdOn} > ${input.since.toISOString()}::timestamptz`,
        sql`${tickets.createdOn} <= ${input.until.toISOString()}::timestamptz`,
        sql`${tickets.orgId} <> ${input.excludeOrgId}::uuid`,
        isNull(tickets.mergedIntoId),
      ),
    )
    .groupBy(tickets.errorSignature)
    .having(sql`count(distinct ${tickets.orgId}) >= ${input.minOrgs}`);
  return rows;
}

/** Обращения с сигнатурой за окно: кнопка "Создать известную проблему" по всплеску. */
export async function signatureTicketIdsTx(tx: Tx, input: { signature: string; since: Date; until: Date }): Promise<string[]> {
  const rows = await tx
    .select({ ticketId: tickets.ticketId })
    .from(tickets)
    .where(
      and(
        eq(tickets.errorSignature, input.signature),
        sql`${tickets.createdOn} > ${input.since.toISOString()}::timestamptz`,
        sql`${tickets.createdOn} <= ${input.until.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(tickets.number))
    .limit(500);
  return rows.map((row) => row.ticketId);
}
