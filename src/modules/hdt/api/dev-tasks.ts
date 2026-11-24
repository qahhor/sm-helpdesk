import 'server-only';

// Модуль hdt, слой api: то, что берёт у обращений передача в разработку (модуль hdw; ТЗ 7.9; план M8, задачи 7 и 8).
// Узкий файл: его тянет и фоновый процесс (вебхук и опрос таск-менеджера закрывают задачу от имени системы), страниц
// и Next.js в нём нет. Модуль обращений о задачах разработки не знает: модуль hdw ведёт свои таблицы и вызывает эти
// функции из своей транзакции. Таблицы обращений модуль hdw сам не читает и не пишет.

export {
  assertCanDevelop,
  assertCanHandOver,
  devHandOverTx,
  devLockTicketTx,
  devTaskClosedTx,
  devTaskHistoryTx,
  type DevTaskSource,
  devTaskSourceTx,
  devTicketRefTx,
} from '../core/dev-tasks';
export { ticketNumbersTx } from '../core/automation';
export type { LockedTicket } from '../core/agent-actions';
