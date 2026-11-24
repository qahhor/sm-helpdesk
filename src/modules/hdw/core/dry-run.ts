import 'server-only';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { recentTicketIdsTx } from '@/modules/hdt/api/automation';
import type { Priority } from '@/modules/hdt/pref';
import { staffRoster } from '@/modules/hdu/api/automation';
import { evaluate } from '../evaluate';
import { HdwError } from '../error';
import { DRY_RUN_TICKETS } from '../pref';
import type { RuleDefinition } from '../rule-schema';
import type { ActionDone } from '../schema';
import { describeAction, dryRunRefsTx } from './actions';
import { snapshotsTx } from './snapshot';

// Модуль hdw, слой core: пробный прогон правила (FR-AUTO-08; план M8, задача 3, решение 6). Берутся последние 100
// обращений в их текущем состоянии: на каких условия выполнены и что сделали бы действия. Вид события по истории не
// проверяется: прогон отвечает на вопрос "каким обращениям подошли бы условия", а не "случилось ли с ними событие".
// В базу пишется одна запись журнала аудита о самом прогоне; обращения, правила и срабатывания не меняются.

export type DryRunMatch = { number: number; priority: Priority; orgName: string; actions: ActionDone[] };
export type DryRunResult = { checked: number; count: number; matches: DryRunMatch[] };

export async function dryRunTx(actor: StaffActor, rule: RuleDefinition, now: Date): Promise<DryRunResult> {
  if (actor.staffRole !== 'admin') throw new HdwError('forbidden');
  const roster = await staffRoster();
  return withActor(actor, async (tx) => {
    const ids = await recentTicketIdsTx(tx, DRY_RUN_TICKETS);
    const snapshots = await snapshotsTx(tx, ids, now);
    const refs = await dryRunRefsTx(tx, rule.actions, roster);
    const matches: DryRunMatch[] = [];
    // Порядок как у отбора: от новых обращений к старым.
    for (const ticketId of ids) {
      const snapshot = snapshots.byId.get(ticketId);
      if (!snapshot || !evaluate(rule, snapshot, now)) continue;
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
    return { checked: ids.length, count: matches.length, matches };
  });
}
