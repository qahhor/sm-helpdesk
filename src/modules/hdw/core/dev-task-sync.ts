import 'server-only';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import type { DevTracker } from '../dev-tracker';
import { DevTrackerUnavailableError, DevTrackerUnknownStatusError } from '../dev-tracker/smartup';
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
/** Столько сбоев сети подряд останавливают запуск: таск-менеджер недоступен, остальные задачи подождут. */
export const SYNC_MAX_FAILURES = 5;

/**
 * Сбой говорит о недоступности таск-менеджера целиком: нет ответа, нет соединения или ошибка сервера. Отказ по
 * одной задаче (ответ 4xx, ответ не по договору) и сбой базы при записи статуса сюда не входят: они не повод
 * останавливать опрос остальных задач (проверка вехи M8, находка I4).
 */
const isOutage = (error: unknown): boolean => error instanceof DevTrackerUnavailableError && /^(timeout|unreachable|blocked_address|http_5\d\d)$/.test(error.code);

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

/**
 * Отметить неудачную попытку: задача остаётся несверенной (её возьмёт следующий запуск), но встаёт в конец очереди
 * опроса. Сбой самой отметки не бросает: это та же недоступность базы, о ней уже есть запись в журнале.
 */
async function touchAttempted(actor: SystemActor, devTaskId: string, now: Date): Promise<void> {
  try {
    await withActor(actor, (tx) => tx.update(devTasks).set({ syncAttemptedOn: now }).where(eq(devTasks.devTaskId, devTaskId)));
  } catch (error) {
    logEvent('warn', 'devtask.attempt_not_saved', { error: error instanceof Error ? error.name : 'ошибка' });
  }
}

export type SyncOptions = { now?: Date; stopped?: () => boolean };
export type SyncResult = { checked: number; updated: number; failed: number; reminded: number };

/**
 * Опрос таск-менеджера: открытые задачи режима API (todo, in_progress), не сверенные 15 минут, не больше
 * SYNC_MAX_TASKS за запуск. Порядок: сначала те, к которым давно не обращались (позднее из момента сверки и момента
 * неудачной попытки), поэтому задача, которая не читается постоянно, не стоит каждый раз первой. Сбой чтения одной
 * задачи записывается в счётчик и не мешает остальным; SYNC_MAX_FAILURES сбоев сети подряд (isOutage) останавливают
 * запуск до следующего раза. Ошибку запуск не бросает.
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
      .orderBy(sql`greatest(${devTasks.syncedOn}, ${devTasks.syncAttemptedOn}) asc nulls first`, asc(devTasks.devTaskId))
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
      // Подряд считаются только сбои сети: отказ по одной задаче или сбой записи не значит, что таск-менеджер недоступен.
      failuresInRow = isOutage(error) ? failuresInRow + 1 : 0;
      result.failed += 1;
      // Вид ошибки без текста: сбой сети уже записан реализацией, здесь остаётся сбой базы.
      logEvent('warn', 'devtask.sync_failed', { ref: task.externalId, error: error instanceof Error ? error.name : 'ошибка' });
      await touchAttempted(actor, task.devTaskId, now);
    }
  }
  return result;
}
