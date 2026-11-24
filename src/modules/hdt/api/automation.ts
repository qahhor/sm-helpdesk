import 'server-only';
import { type Calendar, workingMinutesBetween } from '../sla';

// Модуль hdt, слой api: то, что берёт у обращений модуль правил автоматизации (hdw; план M8, задача 3). Узкий файл:
// его тянет фоновый процесс, страниц и Next.js в нём нет. Модуль обращений о правилах не знает: он пишет события
// предметной области, а правила вызывают эти функции из транзакции системного актора (lockRuleTicketTx это
// проверяет). Таблицы обращений модуль правил сам не читает и не пишет.

export {
  lockRuleTicketTx,
  recentTicketIdsTx,
  type RuleActionResult,
  ruleAddNoteTx,
  ruleAddTagTx,
  ruleAssignTx,
  ruleHistoryTx,
  ruleNotifyBreachTx,
  ruleNotifyCsatLowTx,
  ruleOncallP1Tx,
  rulePickRoundRobinTx,
  ruleRemoveTagTx,
  ruleReplyTx,
  ruleSetPriorityTx,
  ruleSetQueueTx,
  ruleSetStatusTx,
  ruleSnoozeTx,
  type RuleTicketFacts,
  ruleTicketFactsTx,
  type Silence,
  silenceOfTx,
  silentTicketsTx,
  ticketNumbersTx,
  ticketsWithEventTx,
} from '../core/automation';
export type { LockedTicket } from '../core/agent-actions';
export { isHdtError } from '../error';

/** Идёт ли в этот момент рабочее время по календарю (тому же, по которому считаются сроки SLA): ближайшая минута рабочая. */
export function isWorkingTime(now: Date, calendar: Calendar): boolean {
  return workingMinutesBetween(now, new Date(now.getTime() + 60_000), calendar) > 0;
}
