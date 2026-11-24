import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { type SyncOptions, type SyncResult, syncDevTasksTx } from '../core/dev-task-sync';
import { devTrackerMode, getDevTracker } from '../dev-tracker';

// Модуль hdw, слой api: опрос таск-менеджера Smartup для фонового процесса (FR-DEV-04; план M8, задача 8). Узкий
// файл: его берёт фоновый процесс, в сборку которого не должны попадать страницы и Next.js. Вызывает только система.

export type { SyncOptions, SyncResult } from '../core/dev-task-sync';
export { SYNC_EVERY_MIN } from '../core/dev-task-sync';

/**
 * Задание devtasks.sync раз в 15 минут: статусы открытых задач из таск-менеджера. В ручном режиме ничего не делает:
 * статус задачи там меняет сотрудник.
 */
export async function syncDevTasks(actor: SystemActor, opts: SyncOptions = {}): Promise<SyncResult> {
  if (actor.type !== 'system') throw new Error('Опрос таск-менеджера выполняет только система');
  if (devTrackerMode() !== 'smartup') return { checked: 0, updated: 0, failed: 0, reminded: 0 };
  return syncDevTasksTx(actor, getDevTracker(), opts);
}
