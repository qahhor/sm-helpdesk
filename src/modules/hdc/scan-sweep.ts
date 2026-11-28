import 'server-only';
import { logEvent } from '@/lib/log';
import { getStorage } from './storage';

// Модуль hdc: общий порядок обхода зависших проверок файлов (проверка качества, Q5), тот же, что у вложений
// обращений (решение 0028, src/modules/hdt/core/attachments.ts). Таблицы у модулей свои, поэтому модуль передаёт два
// запроса к своей таблице и постановку своей задачи; порядок и сроки общие.

/** Файл pending старше этого срока ставится на проверку снова: постановка после "загрузка завершена" могла не пройти. */
export const SCAN_REQUEUE_AFTER_MS = 2 * 60_000;
/** Пока файла в карантине нет, браузер, возможно, ещё загружает его: такой ставится только через час, проверка его отклонит. */
export const SCAN_ABANDONED_AFTER_MS = 60 * 60_000;
/** Проверка, не прошедшая за сутки, заканчивается: файл не принимается. */
export const SCAN_FAILED_AFTER_MS = 24 * 60 * 60_000;
/** Строк за один обход: после долгого простоя антивируса зависших файлов много. */
export const SCAN_SWEEP_BATCH = 200;

export type ScanSweepSource = {
  /** Название для журнала: "kb" или "ideas". */
  name: string;
  /** Перевести в "не принят" строки pending, созданные раньше срока; вернуть их идентификаторы. */
  rejectStuck: (before: Date, limit: number) => Promise<string[]>;
  /** Строки pending, созданные раньше срока, от старых к новым. */
  listPending: (before: Date, limit: number) => Promise<{ id: string; createdOn: Date }[]>;
  quarantineKey: (id: string) => string;
  /** Поставить задачу проверки файла. */
  enqueue: (id: string) => Promise<void>;
};

export async function sweepPendingScans(source: ScanSweepSource, now: Date): Promise<{ requeued: number; failed: number }> {
  const storage = getStorage();
  const stuck = await source.rejectStuck(new Date(now.getTime() - SCAN_FAILED_AFTER_MS), SCAN_SWEEP_BATCH);
  for (const id of stuck) {
    // В журнале только идентификатор файла.
    logEvent('error', 'files.scan_failed', { source: source.name, fileId: id });
    await storage.remove(source.quarantineKey(id)).catch(() => undefined);
  }
  const pending = await source.listPending(new Date(now.getTime() - SCAN_REQUEUE_AFTER_MS), SCAN_SWEEP_BATCH);
  let requeued = 0;
  for (const row of pending) {
    const abandoned = row.createdOn.getTime() < now.getTime() - SCAN_ABANDONED_AFTER_MS;
    if (!abandoned && !(await storage.head(source.quarantineKey(row.id)))) continue;
    await source.enqueue(row.id);
    requeued += 1;
  }
  return { requeued, failed: stuck.length };
}
