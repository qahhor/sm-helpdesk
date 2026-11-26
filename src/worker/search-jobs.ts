import type { SystemActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import {
  cleanupDroppedOutbox,
  DRIFT_ALERT_SHARE,
  getSearchWriter,
  reconcileCollection,
  type ReconcileReport,
  runSearchSync,
  SEARCH_COLLECTIONS,
  type SearchIndexWriter,
} from '@/modules/hdc/api';
import { raiseOpsAlert } from './ops-watch';

// Задачи индекса поиска фонового процесса (план W6, решения 11 и 12). Частью модуля не является: берёт у ядра api.

/** Сколько длится один запуск search.sync: расписание раз в минуту, следующий запуск не должен его догнать. */
const SYNC_BUDGET_MS = 50_000;
/** Пауза опроса пустой очереди внутри запуска: запись в индекс идёт через секунды после изменения. */
const SYNC_IDLE_MS = 2_000;

let writer: SearchIndexWriter | null | undefined;
const writerOf = () => (writer === undefined ? (writer = getSearchWriter()) : writer);

/** Тесты подменяют запись (undefined возвращает настоящую из окружения). */
export function setSearchJobWriterForTests(value: SearchIndexWriter | null | undefined): void {
  writer = value;
}

export async function searchSyncTick(system: SystemActor, opts: { stopped: () => boolean; budgetMs?: number; idleMs?: number }): Promise<void> {
  const started = Date.now();
  const total = { written: 0, failed: 0, dropped: 0, cleared: 0 };
  while (!opts.stopped()) {
    const result = await runSearchSync(system, writerOf());
    total.written += result.written;
    total.failed += result.failed;
    total.dropped += result.dropped;
    total.cleared += result.cleared;
    if (Date.now() - started >= (opts.budgetMs ?? SYNC_BUDGET_MS)) break;
    if (result.written + result.failed === 0) await new Promise((resolve) => setTimeout(resolve, opts.idleMs ?? SYNC_IDLE_MS));
  }
  if (total.written + total.failed + total.cleared > 0) logEvent(total.failed > 0 ? 'warn' : 'info', 'search.sync', total);
}

/**
 * Ночная сверка всех коллекций (решение 12): недостающее и устаревшее в очередь, лишнее удаляется. Расхождение больше
 * 0.1% даёт сигнал search_drift. Строки очереди после пятого сбоя сверка учла, они удаляются.
 */
export async function searchReconcile(system: SystemActor, now: Date = new Date()): Promise<ReconcileReport[]> {
  const w = writerOf();
  if (!w) return [];
  const reports: ReconcileReport[] = [];
  for (const collection of SEARCH_COLLECTIONS) {
    const report = await reconcileCollection(system, w, collection);
    reports.push(report);
    logEvent(report.drift > DRIFT_ALERT_SHARE ? 'warn' : 'info', 'search.reconcile', report);
  }
  const drifted = reports.filter((r) => r.drift > DRIFT_ALERT_SHARE);
  if (drifted.length > 0)
    await raiseOpsAlert(system, { code: 'search_drift', count: drifted.reduce((n, r) => n + r.missing + r.stale + r.extra, 0), collections: drifted.map((r) => r.collection).join(', ') }, now);
  await cleanupDroppedOutbox(system);
  return reports;
}
