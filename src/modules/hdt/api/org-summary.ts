import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { ClientActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { HdtError } from '../error';
import { TICKET_STATUSES, type TicketStatus } from '../pref';
import { tickets } from '../schema';

// Модуль hdt, слой api: сводка по обращениям организации для администратора клиента (ТЗ 5.1: client_admin видит все
// обращения организации; волна 7, T8). Числа по статусам. Организация берётся из актора, а не из запроса; запрос
// идёт под актором клиента, политика RLS отдаёт только строки его организации. Обычному участнику сводки нет.

export type OrgTicketSummary = { total: number; open: number; byStatus: Record<TicketStatus, number> };

const CLOSED: readonly TicketStatus[] = ['resolved', 'closed'];

export async function orgTicketSummary(ctx: { actor: ClientActor }): Promise<OrgTicketSummary> {
  const actor = ctx.actor;
  if (actor.type !== 'client' || actor.orgRole !== 'client_admin') throw new HdtError('forbidden');
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ status: tickets.status, count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(eq(tickets.orgId, actor.orgId))
      .groupBy(tickets.status),
  );
  const byStatus = Object.fromEntries(TICKET_STATUSES.map((status) => [status, 0])) as Record<TicketStatus, number>;
  for (const row of rows) if ((TICKET_STATUSES as readonly string[]).includes(row.status)) byStatus[row.status as TicketStatus] = row.count;
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { total, open: total - CLOSED.reduce((sum, status) => sum + byStatus[status], 0), byStatus };
}
