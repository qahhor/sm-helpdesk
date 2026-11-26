import 'server-only';
import type { Tx } from '@/db/client';
import { readSlaConfig } from '@/modules/hdr/api';
import { isWorkingTime, ruleTicketFactsTx } from '@/modules/hdt/api/automation';
import { orgFactsTx } from '@/modules/hdu/api/automation';
import type { TicketSnapshot } from '../evaluate';

// Модуль hdw, слой core: снимок обращения для условий правила (FR-AUTO-03; план M8, задача 3). Поля обращения и теги
// даёт модуль обращений, категорию организации модуль пользователей, рабочее время считается по календарю сроков SLA.

export type Snapshots = { byId: Map<string, TicketSnapshot>; orgNames: Map<string, string> };

/** Снимки обращений на момент now в транзакции вызывающего: системы при применении, администратора в пробном прогоне. */
export async function snapshotsTx(tx: Tx, ticketIds: readonly string[], now: Date, opts: { withText?: boolean } = {}): Promise<Snapshots> {
  const byId = new Map<string, TicketSnapshot>();
  const orgNames = new Map<string, string>();
  if (ticketIds.length === 0) return { byId, orgNames };
  // withText: false: тема и описание не читаются (в снимке пустые строки). Так просматривает молчащие обращения
  // правило без условия по тексту: тексты клиентов не гоняются из базы каждую минуту.
  const facts = await ruleTicketFactsTx(tx, ticketIds, opts);
  const orgs = await orgFactsTx(tx, [...facts.values()].map((ticket) => ticket.orgId));
  const working = isWorkingTime(now, (await readSlaConfig(tx)).calendar);
  for (const [ticketId, ticket] of facts) {
    const org = orgs.get(ticket.orgId);
    if (org) orgNames.set(ticket.orgId, org.name);
    byId.set(ticketId, {
      ticketId,
      orgId: ticket.orgId,
      number: ticket.number,
      type: ticket.type,
      moduleId: ticket.moduleId,
      priority: ticket.priority,
      impact: ticket.impact,
      status: ticket.status,
      queue: ticket.queue,
      source: ticket.source,
      locale: ticket.locale,
      orgCategory: org?.category ?? null,
      tagIds: ticket.tagIds,
      title: ticket.title,
      description: ticket.description,
      createdOn: ticket.createdOn,
      lastClientMessageOn: ticket.lastClientMessageOn,
      lastStaffMessageOn: ticket.lastStaffMessageOn,
      rating: ticket.rating,
      isWorkingTime: working,
      assigneeId: ticket.assigneeId,
      aiHandoffReason: ticket.aiHandoffReason,
    });
  }
  return { byId, orgNames };
}

export async function snapshotTx(tx: Tx, ticketId: string, now: Date): Promise<TicketSnapshot | null> {
  return (await snapshotsTx(tx, [ticketId], now)).byId.get(ticketId) ?? null;
}
