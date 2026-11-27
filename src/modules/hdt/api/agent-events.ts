import 'server-only';
import { inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { tickets } from '../schema';

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
