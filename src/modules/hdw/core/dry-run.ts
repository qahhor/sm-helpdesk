import 'server-only';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { recentTicketIdsTx, ticketsWithEventTx } from '@/modules/hdt/api/automation';
import type { Priority, TicketStatus } from '@/modules/hdt/pref';
import { staffRoster } from '@/modules/hdu/api/automation';
import { evaluate } from '../evaluate';
import { HdwError } from '../error';
import { DRY_RUN_TICKETS, type RuleEvent } from '../pref';
import type { RuleDefinition } from '../rule-schema';
import type { ActionDone } from '../schema';
import { describeAction, dryRunRefsTx } from './actions';
import { silentForDryRunTx } from './engine';
import { snapshotsTx } from './snapshot';

// Модуль hdw, слой core: пробный прогон правила (FR-AUTO-08; план M8, задача 3, решение 6; волна 5, задача 2).
// Обращения отбираются так, как их выбрало бы настоящее применение. Правило на событие обращения: из последних 100
// обращений по созданию те, у которых по истории было событие этого вида (очередь событий предметной области хранится
// 30 суток, поэтому смотрится история обращения). Правило "нет активности": обращения, которые молчат не меньше
// заданных часов, с тем же определением молчания и просмотром статусов, что у настоящего просмотра, последние 100.
// Условия проверяются на текущем состоянии обращения; что сделали бы действия, описывается без изменений.
// В базу пишется одна запись журнала аудита о самом прогоне; обращения, правила и срабатывания не меняются.

export type DryRunMatch = { number: number; priority: Priority; orgName: string; actions: ActionDone[] };
/**
 * По какому признаку отобраны обращения: событие вида правила среди последних window обращений или молчание не
 * меньше hours часов (последние window таких обращений).
 */
export type DryRunBasis = { kind: 'event'; event: Exclude<RuleEvent, 'no_activity'>; window: number } | { kind: 'silent'; hours: number; window: number };
/** checked: сколько обращений отобрано и проверено условиями; count: на скольких условия выполнены. */
export type DryRunResult = { checked: number; count: number; matches: DryRunMatch[]; basis: DryRunBasis };

export async function dryRunTx(actor: StaffActor, rule: RuleDefinition, now: Date): Promise<DryRunResult> {
  if (actor.staffRole !== 'admin') throw new HdwError('forbidden');
  const roster = await staffRoster();
  return withActor(actor, async (tx) => {
    let ids: string[];
    let basis: DryRunBasis;
    // Статусы просмотра "нет активности": их проверяет и настоящее применение на снимке.
    let statuses: readonly TicketStatus[] | null = null;
    if (rule.event === 'no_activity') {
      if (rule.hours === null) throw new HdwError('invalid_input');
      const silent = await silentForDryRunTx(tx, { conditions: rule.conditions, hours: rule.hours }, now, DRY_RUN_TICKETS);
      ids = silent.ticketIds;
      statuses = silent.statuses;
      basis = { kind: 'silent', hours: rule.hours, window: DRY_RUN_TICKETS };
    } else {
      const recent = await recentTicketIdsTx(tx, DRY_RUN_TICKETS);
      const had = await ticketsWithEventTx(tx, recent, rule.event, now);
      ids = recent.filter((ticketId) => had.has(ticketId));
      basis = { kind: 'event', event: rule.event, window: DRY_RUN_TICKETS };
    }
    const snapshots = await snapshotsTx(tx, ids, now);
    const refs = await dryRunRefsTx(tx, rule.actions, roster);
    const matches: DryRunMatch[] = [];
    // Порядок как у отбора: от новых обращений к старым.
    for (const ticketId of ids) {
      const snapshot = snapshots.byId.get(ticketId);
      if (!snapshot || (statuses && !statuses.includes(snapshot.status)) || !evaluate(rule, snapshot, now)) continue;
      matches.push({
        number: snapshot.number,
        priority: snapshot.priority,
        orgName: snapshots.orgNames.get(snapshot.orgId) ?? '',
        actions: rule.actions.map((action) => describeAction(action, snapshot, refs, now)),
      });
    }
    await writeAudit(tx, {
      action: 'rule.dry_run',
      objectType: 'rule',
      ...(rule.ruleId ? { objectId: rule.ruleId } : {}),
      diff: { name: rule.name, event: rule.event, checked: ids.length, matched: matches.length },
    });
    return { checked: ids.length, count: matches.length, matches, basis };
  });
}
