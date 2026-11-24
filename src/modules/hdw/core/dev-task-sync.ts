import 'server-only';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import type { DevTracker } from '../dev-tracker';
import { DevTrackerUnknownStatusError } from '../dev-tracker/smartup';
import type { DevTaskStatus } from '../pref';
import { devTasks } from '../schema';
import { applyDevTaskStatusTx, devTaskByRefTx, lockDevTaskTx } from './dev-tasks';

// Модуль hdw, слой core: статус задачи разработки из таск-менеджера Smartup (FR-DEV-04, 05; план M8, задача 8).
// Два входа с одним итогом: вебхук (applyTrackerUpdate) и опрос раз в 15 минут (syncDevTasksTx). Пишет только
// система. Запрос к таск-менеджеру идёт вне транзакции: соединение с базой не держится, пока ждём сеть.

/** Задача не сверялась столько минут: опрос берёт её снова (FR-DEV-04). */
export const SYNC_EVERY_MIN = 15;
/** Столько задач читает один запуск опроса: остальные возьмёт следующий. */
export const SYNC_MAX_TASKS = 200;
/** Столько сбоев таск-менеджера подряд останавливают запуск: он недоступен, остальные задачи подождут. */
export const SYNC_MAX_FAILURES = 5;

const OPEN: DevTaskStatus[] = ['todo', 'in_progress'];

function requireSystem(actor: SystemActor): void {
  if (actor.type !== 'system') throw new Error('Статус задачи из таск-менеджера пишет только система');
}

/**
 * Записать статус задачи таск-менеджера по её номеру. Задачи с таким номером портал не знает: null. Тот же статус:
 * меняется только отметка сверки. Закрытие задачи один раз напоминает исполнителям привязанных обращений.
 */
export async function applyTrackerUpdate(
  actor: SystemActor,
  ref: string,
  update: { status: DevTaskStatus; version?: string; url?: string },
  now: Date = new Date(),
): Promise<{ changed: boolean; reminded: number } | null> {
  requireSystem(actor);
  return withActor(actor, async (tx) => {
    const found = await devTaskByRefTx(tx, 'smartup', ref);
    const task = found ? await lockDevTaskTx(tx, found.devTaskId) : null;
    if (!task) return null;
    return applyDevTaskStatusTx(tx, task, { status: update.status, ...(update.version !== undefined ? { version: update.version } : {}), ...(update.url !== undefined ? { url: update.url } : {}), synced: now }, null);
  });
}

/** Отметить задачу сверенной без изменения статуса: незнакомый статус или задача пропала из таск-менеджера. */
async function touchSynced(actor: SystemActor, devTaskId: string, now: Date): Promise<void> {
  await withActor(actor, (tx) => tx.update(devTasks).set({ syncedOn: now }).where(eq(devTasks.devTaskId, devTaskId)));
}

export type SyncOptions = { now?: Date; stopped?: () => boolean };
export type SyncResult = { checked: number; updated: number; failed: number; reminded: number };

/**
 * Опрос таск-менеджера: открытые задачи режима API (todo, in_progress), не сверенные 15 минут, давно не сверенные
 * первыми, не больше SYNC_MAX_TASKS за запуск. Сбой чтения одной задачи записывается в счётчик и не мешает
 * остальным; несколько сбоев подряд останавливают запуск до следующего раза. Ошибку запуск не бросает.
 */
export async function syncDevTasksTx(actor: SystemActor, tracker: DevTracker, opts: SyncOptions = {}): Promise<SyncResult> {
  requireSystem(actor);
  const now = opts.now ?? new Date();
  const before = new Date(now.getTime() - SYNC_EVERY_MIN * 60_000);
  const due = await withActor(actor, (tx) =>
    tx
      .select({ devTaskId: devTasks.devTaskId, externalId: devTasks.externalId })
      .from(devTasks)
      .where(and(eq(devTasks.tracker, 'smartup'), inArray(devTasks.status, OPEN), or(isNull(devTasks.syncedOn), lt(devTasks.syncedOn, before))))
      .orderBy(sql`${devTasks.syncedOn} asc nulls first`, asc(devTasks.devTaskId))
      .limit(SYNC_MAX_TASKS),
  );
  const result: SyncResult = { checked: 0, updated: 0, failed: 0, reminded: 0 };
  let failuresInRow = 0;
  for (const task of due) {
    if (opts.stopped?.() || failuresInRow >= SYNC_MAX_FAILURES) break;
    result.checked += 1;
    try {
      const remote = await tracker.getTask(task.externalId);
      failuresInRow = 0;
      if (!remote) {
        // Задачу удалили в таск-менеджере: статус в портале остаётся, сотрудник увидит его на странице обращения.
        logEvent('warn', 'devtask.missing', { ref: task.externalId });
        await touchSynced(actor, task.devTaskId, now);
        continue;
      }
      const applied = await applyTrackerUpdate(actor, task.externalId, { status: remote.status, url: remote.url, ...(remote.version ? { version: remote.version } : {}) }, now);
      if (applied?.changed) result.updated += 1;
      result.reminded += applied?.reminded ?? 0;
    } catch (error) {
      if (error instanceof DevTrackerUnknownStatusError) {
        // Незнакомый статус уже записан в журнал реализацией: задача сверена, статус прежний.
        failuresInRow = 0;
        await touchSynced(actor, task.devTaskId, now);
        continue;
      }
      failuresInRow += 1;
      result.failed += 1;
      // Вид ошибки без текста: сбой сети уже записан реализацией, здесь остаётся сбой базы.
      logEvent('warn', 'devtask.sync_failed', { ref: task.externalId, error: error instanceof Error ? error.name : 'ошибка' });
    }
  }
  return result;
}
