import 'server-only';
import type { Tx } from '@/db/client';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { lockProblemTicketTx, type ProblemLinkVia, type ProblemTicket, setTicketProblemTx } from '@/modules/hdt/api/known-problems';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { HdpError } from '../error';
import { isActiveProblem } from '../pref';
import { type ProblemHead, recountProblemTx, requireProblemTx } from './problems';

// Модуль hdp, слой core: привязка обращения к известной проблеме (FR-KP-04; план M5c, решения 8, 9). Одна функция для
// всех путей: из карточки, вручную в обращении, массово, по сигнатуре, правилом. Порядок блокировок: сначала
// обращение, потом проблема; так же у рассылки и закрытия. Привязка: ссылка, внутреннее событие истории, пересчёт
// счётчиков проблемы и запись журнала аудита одной транзакцией. Сроки SLA и статус обращения не меняются (решение 12).

export type LinkResult = 'linked' | 'unchanged';

/** Обращение можно привязать: не закрыто, не объединено, не из "Неопознанных". */
function assertLinkable(ticket: ProblemTicket): void {
  if (ticket.status === 'closed' || ticket.mergedIntoId !== null || ticket.orgId === SERVICE_ORG_ID) throw new HdpError('ticket_closed');
}

/**
 * Привязать заблокированное обращение к проблеме. Уже привязано к ней же: unchanged. К другой: already_linked
 * (решение 9). Закрытая проблема: problem_closed; активность требуется для привязки по сигнатуре и правилом.
 */
export async function linkLockedTicketTx(
  tx: Tx,
  actor: StaffActor | SystemActor,
  ticket: ProblemTicket,
  problem: ProblemHead,
  via: ProblemLinkVia,
): Promise<LinkResult> {
  if (ticket.knownProblemId === problem.problemId) return 'unchanged';
  if (ticket.knownProblemId !== null) throw new HdpError('already_linked');
  assertLinkable(ticket);
  if (problem.status === 'closed') throw new HdpError('problem_closed');
  // К черновику обращения не привязываются: сначала сотрудник его принимает (решение 20 плана M8b).
  if (problem.status === 'draft') throw new HdpError('problem_draft');
  if ((via === 'signature' || via === 'rule') && !isActiveProblem(problem.status)) throw new HdpError('problem_inactive');
  await setTicketProblemTx(tx, actor, ticket, { problemId: problem.problemId, problemNumber: problem.number, via });
  await recountProblemTx(tx, problem.problemId);
  await writeAudit(tx, { action: 'ticket.problem_linked', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: { problemNumber: problem.number, via } });
  return 'linked';
}

/** Привязать обращение по номеру или идентификатору к проблеме по номеру или идентификатору. */
export async function linkTicketTx(
  tx: Tx,
  actor: StaffActor | SystemActor,
  input: { ticket: { number: number } | { ticketId: string }; problem: { number: number } | { problemId: string }; via: ProblemLinkVia },
): Promise<{ result: LinkResult; ticket: ProblemTicket; problem: ProblemHead }> {
  const ticket = await lockProblemTicketTx(tx, input.ticket);
  const problem = await requireProblemTx(tx, input.problem, { lock: true });
  return { result: await linkLockedTicketTx(tx, actor, ticket, problem, input.via), ticket, problem };
}

/** Отвязать обращение (решение 9). Не привязано: false. Отвязка закрытого обращения разрешена: это исправление ошибки. */
export async function unlinkTicketTx(tx: Tx, actor: StaffActor | SystemActor, key: { number: number } | { ticketId: string }): Promise<boolean> {
  const ticket = await lockProblemTicketTx(tx, key);
  if (!ticket.knownProblemId) return false;
  const problem = await requireProblemTx(tx, { problemId: ticket.knownProblemId }, { lock: true });
  await setTicketProblemTx(tx, actor, ticket, { problemId: null, problemNumber: problem.number, via: 'manual' });
  await recountProblemTx(tx, problem.problemId);
  await writeAudit(tx, { action: 'ticket.problem_unlinked', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff: { problemNumber: problem.number } });
  return true;
}
