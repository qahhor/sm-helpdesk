import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { staffRoster } from '@/modules/hdu/api/automation';
import { insertCutoffTx, monthSpendTx } from '../core/runs';
import { AI_BUDGET_WARN_SHARE } from '../pref';
import { aiConfig } from './config';

// Модуль hda, слой api: задача ai.budget раз в 10 минут (FR-AI-17; проверка на AI-инъекции, пункт 5; план M5b,
// решение 11). Расход считается по журналу вызовов за месяц по Ташкенту, все цели вместе:
//   - от 80% месячного предела организации, израсходовавшие больше доли предела (ai.cutoff_share, 25%), отключаются от
//     помощника до конца месяца: один клиент не выключает помощника всем;
//   - от 100% помощник отключается для всех до конца месяца.
// Каждое новое отключение один раз уведомляет администраторов портала в колокольчике. Повтор задачи ничего не дублирует.

export type BudgetResult = { spentUsd: number; budgetUsd: number; orgsCut: number; allCut: boolean };

export async function runAiBudget(system: SystemActor): Promise<BudgetResult> {
  if (system.type !== 'system') throw new Error('hda: задача только для системы');
  const config = await aiConfig();
  const budget = config.monthlyBudgetUsd;
  const admins = (await staffRoster()).filter((member) => member.role === 'admin');
  return withActor(system, async (tx) => {
    const spend = await monthSpendTx(tx);
    const result: BudgetResult = { spentUsd: Math.round(spend.total * 100) / 100, budgetUsd: budget, orgsCut: 0, allCut: false };
    if (spend.total < budget * AI_BUDGET_WARN_SHARE) return result;
    for (const org of spend.byOrg) if (org.usd > budget * config.cutoffShare && (await insertCutoffTx(tx, org.orgId))) result.orgsCut++;
    if (spend.total >= budget) result.allCut = await insertCutoffTx(tx, null);
    const percent = spend.total >= budget ? 100 : 80;
    if (result.orgsCut > 0 || result.allCut) {
      for (const admin of admins) await notifyTx(tx, { userId: admin.userId, kind: 'ai_budget', payload: { percent, orgs: result.orgsCut } });
      logEvent('warn', 'ai.budget_cutoff', { percent, orgs: result.orgsCut, all: result.allCut });
    }
    return result;
  });
}
