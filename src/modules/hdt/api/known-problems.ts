import 'server-only';

// Модуль hdt, слой api: то, что берёт у обращений модуль известных проблем hdp (план M5c, задачи 2 и 3). Узкий файл
// без страниц и Next.js: его тянет и фоновый процесс. Функции работают внутри транзакции вызывающего.

export {
  lockProblemTicketTx,
  type ProblemLinkVia,
  problemOrgIdsTx,
  problemTicketTx,
  type ProblemTicket,
  type ProblemTicketRow,
  problemTicketSignaturesTx,
  problemTicketsTx,
  setTicketProblemTx,
  signatureTicketCountsTx,
  unlinkedTicketIdsTx,
} from '../core/known-problems';
