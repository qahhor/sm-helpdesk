import 'server-only';
import type { Tx } from '@/db/client';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { enqueueTx } from '@/modules/hdn/api/outbox';
import { problemTx, requireProblemTx } from '../core/problems';
import { problemRef } from '../util';

// Модуль hdp, слой api: известная проблема и её задача разработки (ТЗ FR-KP-11, FR-DEV-06; план M5c, задача 8, решение
// 25). Для модуля hdw: проверка проблемы при привязке и уведомление владельца о смене статуса задачи. Клиентам ничего
// не уходит, статус проблемы сам не меняется: его меняет сотрудник.


/** Проблема для привязки задачи по номеру; lock: строка заблокирована (привязка, отвязка). Нет проблемы: not_found. */
export async function problemForDevTaskTx(tx: Tx, number: number, opts: { lock?: boolean } = {}): Promise<{ problemId: string; number: number; internalTitle: string }> {
  const p = await requireProblemTx(tx, { number }, { lock: opts.lock ?? false });
  return { problemId: p.problemId, number: p.number, internalTitle: p.internalTitle };
}

/** То же без ошибки "не найдено": проблемы с таким номером нет, ответ null. Иные ошибки не глотаются (проверка качества, Q16). */
export async function findProblemForDevTaskTx(tx: Tx, number: number): Promise<{ problemId: string; number: number; internalTitle: string } | null> {
  const p = await problemTx(tx, { number });
  return p ? { problemId: p.problemId, number: p.number, internalTitle: p.internalTitle } : null;
}

export type ProblemDevTaskChange = { ref: string; status: string; version: string | null };

/**
 * Статус задачи разработки сменился (решение 25): владельцу каждой проблемы этой задачи уведомление в портале и письмо
 * "обновите статус проблемы". Тот, кто сам сменил статус, о своём действии не уведомляется. Владельца нет: никому.
 * Возвращает число уведомлений.
 */
export async function problemDevTaskChangedTx(tx: Tx, problemIds: readonly string[], task: ProblemDevTaskChange, actorUserId: string | null): Promise<number> {
  let count = 0;
  for (const problemId of new Set(problemIds)) {
    const p = await requireProblemTx(tx, { problemId });
    if (!p.ownerId || p.ownerId === actorUserId) continue;
    await notifyTx(tx, { userId: p.ownerId, kind: 'problem_dev_task', payload: { problem: p.number, ref: task.ref, status: task.status } });
    await enqueueTx(tx, {
      channel: 'email',
      recipient: { kind: 'user', userId: p.ownerId },
      template: 'staff_problem_dev_task',
      settingsPath: '/agent/account',
      payload: { template: 'staff_problem_dev_task', problem: problemRef(p.number), ref: task.ref, status: task.status, version: task.version, url: `/agent/problems/${p.number}` },
    });
    count += 1;
  }
  return count;
}
