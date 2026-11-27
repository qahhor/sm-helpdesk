import 'server-only';
import { and, inArray, isNotNull } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { ticketMessages, tickets, ticketWatchers } from '../schema';

// Модуль hdt, слой api: сведения обращений для событий AI-сотрудника (веха M8b, задача 9; решение 26). Только коды и
// идентификаторы: темы, описания и автора здесь нет. В транзакции системы вызывающего.

export type AgentEventTicketFacts = { ticketId: string; number: number; priority: string; queue: string | null; moduleId: string | null; orgId: string };

export async function agentEventTicketsTx(tx: Tx, ticketIds: readonly string[]): Promise<AgentEventTicketFacts[]> {
  const ids = [...new Set(ticketIds)];
  if (ids.length === 0) return [];
  return tx
    .select({ ticketId: tickets.ticketId, number: tickets.number, priority: tickets.priority, queue: tickets.queue, moduleId: tickets.moduleId, orgId: tickets.orgId })
    .from(tickets)
    .where(inArray(tickets.ticketId, ids));
}

const PEOPLE_MAX = 2000;
const PROBLEM_ORGS_MAX = 200;

/**
 * Люди обращений для обезличивания ответа AI-сотруднику (независимая проверка M8b, находка I1): автор обращения,
 * авторы сообщений и наблюдатели, в том числе не участники организации (гость из письма, бывший участник). Только
 * идентификаторы; имена читает модуль пользователей. В транзакции системы вызывающего.
 */
export async function agentTicketPeopleTx(tx: Tx, ticketIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(ticketIds)];
  if (ids.length === 0) return [];
  const authors = await tx.selectDistinct({ userId: tickets.authorId }).from(tickets).where(inArray(tickets.ticketId, ids));
  const writers = await tx
    .selectDistinct({ userId: ticketMessages.authorId })
    .from(ticketMessages)
    .where(and(inArray(ticketMessages.ticketId, ids), isNotNull(ticketMessages.authorId)))
    .limit(PEOPLE_MAX);
  const watchers = await tx.selectDistinct({ userId: ticketWatchers.userId }).from(ticketWatchers).where(inArray(ticketWatchers.ticketId, ids)).limit(PEOPLE_MAX);
  return [...new Set([...authors, ...writers, ...watchers].flatMap((row) => (row.userId ? [row.userId] : [])))];
}

/** Организации обращений, привязанных к известным проблемам (находка I2): их название обезличивается в названии проблемы. */
export async function agentProblemOrgsTx(tx: Tx, problemIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(problemIds)];
  if (ids.length === 0) return [];
  const rows = await tx.selectDistinct({ orgId: tickets.orgId }).from(tickets).where(inArray(tickets.knownProblemId, ids)).limit(PROBLEM_ORGS_MAX);
  return rows.map((row) => row.orgId);
}
