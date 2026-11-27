import 'server-only';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import type { KnownProblemLinker, StaffContext } from '@/modules/hdc/api';
import { SERVICE_ORG_ID } from '@/modules/hdu/pref';
import { linkLockedTicketTx, linkTicketTx, unlinkTicketTx } from '../core/links';
import { activeProblemBySignatureTx, listProblemsTx, problemTx, requireProblemTx } from '../core/problems';
import { HdpError, isHdpError } from '../error';
import { parseInput } from '../input';
import { isActiveProblem, PROBLEM_NUMBER_MAX } from '../pref';
import { problemRef } from '../util';
import { lockProblemTicketTx } from '@/modules/hdt/api/known-problems';

// Модуль hdp, слой api: привязка обращений к известной проблеме (ТЗ FR-KP-04, 13, FR-AG-20, UX-A-10; план M5c,
// задача 3, решения 3, 8-10, 12). Вручную и массово привязывает любой сотрудник, который ведёт обращения (не product);
// по сигнатуре в момент создания привязывает система; правилом привязывает разбор правил (модуль hdw). Все пути идут
// одной функцией linkTicketTx: одна проблема на обращение, событие истории, журнал аудита, пересчёт счётчиков.
// Сроки, статус и исполнитель обращения не меняются (FR-KP-13).

const STAFF_WRITE_ROLES = ['agent_l1', 'agent_l2', 'care', 'admin'];
const SYSTEM: SystemActor = { type: 'system', job: 'problems.link' };

const ticketNumber = z.number().int().positive().max(999_999_999_999);
const problemNumber = z.number().int().positive().max(PROBLEM_NUMBER_MAX);
const linkInput = z.strictObject({ ticketNumber, problemNumber });
const unlinkInput = z.strictObject({ ticketNumber });
/** Массовая привязка (решение 10): до 100 обращений; больше: отказ too_many целиком. */
const BULK_MAX = 100;
const bulkInput = z.strictObject({ numbers: z.array(ticketNumber).min(1), problemNumber });

function requireLinker(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !STAFF_WRITE_ROLES.includes(ctx.actor.staffRole)) throw new HdpError('forbidden');
}

/** Привязать обращение к проблеме вручную (блок "Известная проблема" в обращении). */
export async function linkTicketToProblem(ctx: StaffContext, input: unknown): Promise<{ linked: boolean }> {
  requireLinker(ctx);
  const data = parseInput(linkInput, input);
  const { result } = await withActor(ctx.actor, (tx) =>
    linkTicketTx(tx, ctx.actor, { ticket: { number: data.ticketNumber }, problem: { number: data.problemNumber }, via: 'manual' }).catch(notFoundAsHdp),
  );
  return { linked: result === 'linked' };
}

/** Отвязать обращение от проблемы. Не было привязки: unlinked false. */
export async function unlinkTicket(ctx: StaffContext, input: unknown): Promise<{ unlinked: boolean }> {
  requireLinker(ctx);
  const data = parseInput(unlinkInput, input);
  return { unlinked: await withActor(ctx.actor, (tx) => unlinkTicketTx(tx, ctx.actor, { number: data.ticketNumber }).catch(notFoundAsHdp)) };
}

export type BulkLinkResult = { done: number[]; refused: { number: number; code: string }[] };

/**
 * Массовая привязка из очереди (FR-AG-20, решение 10): каждое обращение своей транзакцией той же функцией, что
 * одиночная привязка; отказ одного не отменяет остальные. Итог по каждому.
 */
export async function bulkLinkProblem(ctx: StaffContext, input: unknown): Promise<BulkLinkResult> {
  requireLinker(ctx);
  const data = parseInput(bulkInput, input);
  const numbers = [...new Set(data.numbers)];
  if (numbers.length > BULK_MAX) throw new HdpError('too_many');
  const result: BulkLinkResult = { done: [], refused: [] };
  for (const number of numbers) {
    try {
      await withActor(ctx.actor, (tx) => linkTicketTx(tx, ctx.actor, { ticket: { number }, problem: { number: data.problemNumber }, via: 'bulk' }).catch(notFoundAsHdp));
      result.done.push(number);
    } catch (error) {
      if (!isHdpError(error)) throw error;
      // Нет самой проблемы: отказ для всех, дальше идти незачем.
      if (error.code === 'not_found' && !(await problemExists(ctx, data.problemNumber))) throw error;
      result.refused.push({ number, code: error.code });
    }
  }
  return result;
}

async function problemExists(ctx: StaffContext, number: number): Promise<boolean> {
  return withActor(ctx.actor, (tx) => requireProblemTx(tx, { number }).then(
    () => true,
    () => false,
  ));
}

/** Нет обращения: отказ модуля обращений превращается в отказ модуля проблем с тем же кодом. */
function notFoundAsHdp(error: unknown): never {
  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'not_found' && !isHdpError(error)) throw new HdpError('not_found');
  throw error;
}

/**
 * Привязка нового обращения по сигнатуре (решение 8), подключается в src/wiring.ts. Только обращения настоящих
 * организаций и только к активной проблеме; признак показа на привязку не влияет. Уже привязанное, закрытое и
 * объединённое обращение не трогается.
 */
export const knownProblemLinker: KnownProblemLinker = {
  async linkBySignature(input) {
    if (!input.signature || input.orgId === SERVICE_ORG_ID) return null;
    const signature = input.signature;
    return withActor(SYSTEM, async (tx) => {
      const found = await activeProblemBySignatureTx(tx, signature);
      if (!found) return null;
      const ticket = await lockProblemTicketTx(tx, { ticketId: input.ticketId });
      if (ticket.knownProblemId || ticket.orgId === SERVICE_ORG_ID || ticket.status === 'closed' || ticket.mergedIntoId) return null;
      const problem = await requireProblemTx(tx, { problemId: found.problemId }, { lock: true });
      return (await linkLockedTicketTx(tx, SYSTEM, ticket, problem, 'signature')) === 'linked' ? { problemNumber: problem.number } : null;
    });
  },
  async linkAffected(input) {
    try {
      const { result, problem } = await withActor(SYSTEM, (tx) => linkTicketTx(tx, SYSTEM, { ticket: { ticketId: input.ticketId }, problem: { problemId: input.problemId }, via: 'affected' }));
      return result === 'linked' ? { problemNumber: problem.number } : null;
    } catch (error) {
      if (isHdpError(error)) return null;
      throw error;
    }
  },
};

// --- Для правил автоматизации (модуль hdw; решение 11) ---

/** Действие правила "привязать к KP-n" в транзакции разбора: общая функция привязки, отказ кодом. */
export async function ruleLinkProblemTx(
  tx: Tx,
  input: { ticketId: string; problemNumber: number },
): Promise<{ ok: true; to: string; unchanged?: true } | { ok: false; detail: string }> {
  try {
    const { result, problem } = await linkTicketTx(tx, SYSTEM, { ticket: { ticketId: input.ticketId }, problem: { number: input.problemNumber }, via: 'rule' });
    return { ok: true, to: problemRef(problem.number), ...(result === 'unchanged' ? { unchanged: true as const } : {}) };
  } catch (error) {
    if (isHdpError(error)) return { ok: false, detail: error.code === 'not_found' ? 'problem_missing' : error.code };
    throw error;
  }
}

/** Номера активных проблем из списка: ссылка правила проверяется при сохранении (решение 11). */
export async function activeProblemNumbersTx(tx: Tx, numbers: readonly number[]): Promise<Set<number>> {
  const found = new Set<number>();
  for (const number of new Set(numbers)) {
    const problem = await problemTx(tx, { number });
    if (problem && isActiveProblem(problem.status)) found.add(number);
  }
  return found;
}

/** Активные проблемы для списка в редакторе правил: номер и внутреннее название (видит только администратор). */
export async function activeProblemOptionsTx(tx: Tx): Promise<{ number: number; internalTitle: string }[]> {
  return (await listProblemsTx(tx, { status: 'active' })).map((row) => ({ number: row.number, internalTitle: row.internalTitle }));
}
