import { PgBoss } from 'pg-boss';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { bossOptions, cleanupRateLimits, createPgBossQueue, setJobQueue } from '@/modules/hdc/api';
import { cleanupTelegramUpdates } from '@/modules/hdn/api/maintenance';
import { isHdtError, scanAttachment, sweepAttachments } from '@/modules/hdt/api/jobs';
import { closeConnections } from '@/modules/hdu/api/connections';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';

// Фоновый процесс портала (раздел 11.10, решение 0028): задачи pg-boss под ролью hub_app.
// Собирается в один файл dist/worker.mjs (scripts/build-cli.mjs). В образе: node worker.mjs.
// Модулем не является и, как страницы, берёт у модулей только слой api: узкие файлы каталога api/,
// как команда консоли, чтобы в сборку не попали страницы и Next.js.

/** Расписания: обход загрузок раз в минуту, ночная очистка в 03:00 по Ташкенту (решение 0023). */
export const SCHEDULES = [
  { name: 'attachment.sweep', cron: '* * * * *', tz: 'UTC' },
  { name: 'maintenance.cleanup', cron: '0 3 * * *', tz: 'Asia/Tashkent' },
] as const;

const scanJob = z.object({ attachmentId: z.uuid() }).strict();
const actor = (job: string): SystemActor => ({ type: 'system', job });

/**
 * Сколько раз пытаться запуститься: база или схема pg-boss могут появиться позже процесса (выкладка, где миграции
 * идут параллельно, браузерные тесты). Паузы растут от 1 до 30 секунд, всего около восьми минут (StartOptions pg-boss).
 */
const START_ATTEMPTS = 20;

export interface WorkerOptions {
  connectionString?: string;
  pollingIntervalSeconds?: number;
  /** Попыток запуска: по умолчанию START_ATTEMPTS. */
  startAttempts?: number;
  /** false: без расписаний (тесты). */
  schedules?: boolean;
}

export async function startWorker(opts: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  const boss = new PgBoss(bossOptions(opts.connectionString ?? getEnv().DATABASE_URL_APP, 'worker'));
  boss.on('error', (error) => console.error(`Фоновый процесс: ${error.message}`));
  await boss.start({ attempts: opts.startAttempts ?? START_ATTEMPTS });
  setJobQueue(createPgBossQueue(boss));
  const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };

  await boss.work('attachment.scan', { ...polling, localConcurrency: 2 }, async ([job]) => {
    // В задаче только идентификатор вложения: остальное берётся из базы.
    const { attachmentId } = scanJob.parse(job?.data);
    try {
      await scanAttachment(actor('attachment.scan'), attachmentId);
    } catch (error) {
      // Строки уже нет (удалил обход): делать нечего, повтор не нужен.
      if (isHdtError(error) && error.code === 'not_found') return;
      throw error;
    }
  });
  await boss.work('attachment.sweep', polling, async () => {
    const { requeued, removed } = await sweepAttachments(actor('attachment.sweep'));
    if (requeued > 0 || removed > 0) console.info(`Обход загрузок: снова на проверке ${requeued}, удалено ${removed}`);
  });
  await boss.work('maintenance.cleanup', polling, async () => {
    const system = actor('maintenance.cleanup');
    const limits = await cleanupRateLimits();
    const updates = await cleanupTelegramUpdates(system);
    const { sessions, verifications } = await cleanupAuthRows(system);
    console.info(
      `Ночная очистка: счётчики частоты ${limits}, события Telegram ${updates}, сессии ${sessions}, одноразовые значения входа ${verifications}`,
    );
  });
  if (opts.schedules !== false) for (const s of SCHEDULES) await boss.schedule(s.name, s.cron, null, { tz: s.tz });

  return {
    async stop() {
      setJobQueue(null);
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}

if (import.meta.main) {
  try {
    // Неверное окружение останавливает процесс сразу, как и портал (src/instrumentation.ts).
    getEnv();
    const worker = await startWorker();
    console.info('Фоновый процесс запущен');
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await worker.stop();
      await closeConnections();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
  } catch (error) {
    console.error(`Фоновый процесс не запущен: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
