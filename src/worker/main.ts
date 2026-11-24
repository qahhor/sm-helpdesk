import '@/wiring';
import { PgBoss } from 'pg-boss';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { configureLog, logEvent, timedJob } from '@/lib/log';
import { bossOptions, cleanupAudit, cleanupDomainEvents, cleanupRateLimits, createPgBossQueue, eventsState, JOB_NAMES, processEvents, setJobQueue } from '@/modules/hdc/api';
import { cleanupInbound, cleanupOutbox, cleanupTelegramUpdates } from '@/modules/hdn/api/maintenance';
import { cleanupNotifications } from '@/modules/hdn/api/notifications';
import { requeueStaleInbound } from '@/modules/hdn/api/inbound';
import { scanSolutionFile } from '@/modules/hdk/api/files';
import { dispatchOutbox, outboxState, wakeOutbox } from '@/modules/hdn/api/outbox';
import { intakeEmail } from '@/modules/hdt/api/email-intake';
import { isHdtError, scanAttachment, sweepAttachments, ticketsMinute } from '@/modules/hdt/api/jobs';
import { closeConnections } from '@/modules/hdu/api/connections';
import { cleanupRuleRuns, handleRuleEvent, newRuleRun, type NoActivityOptions, runNoActivityRules } from '@/modules/hdw/api/engine';
import { syncDevTasks } from '@/modules/hdw/api/dev-task-jobs';
import { cleanupWebhookDeliveries, dispatchWebhooks, handleWebhookEvent, hasDueDeliveries, wakeWebhooks } from '@/modules/hdw/api/webhook-jobs';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';
import { opsWatch } from './ops-watch';

// Фоновый процесс портала (раздел 11.10, решение 0028): задачи pg-boss под ролью hub_app.
// Собирается в один файл dist/worker.mjs (scripts/build-cli.mjs). В образе: node worker.mjs.
// Модулем не является и, как страницы, берёт у модулей только слой api: узкие файлы каталога api/,
// как команда консоли, чтобы в сборку не попали страницы и Next.js.

/** Расписания: обход загрузок, задача обращений, отправка очереди писем, разбор событий и правила, отправка вебхуков раз в минуту, опрос таск-менеджера раз в 15 минут, ночная очистка в 03:00 по Ташкенту (решение 0023). */
export const SCHEDULES = [
  { name: 'attachment.sweep', cron: '* * * * *', tz: 'UTC' },
  { name: 'tickets.minute', cron: '* * * * *', tz: 'UTC' },
  { name: 'outbox.dispatch', cron: '* * * * *', tz: 'UTC' },
  { name: 'automation.process', cron: '* * * * *', tz: 'UTC' },
  { name: 'webhooks.dispatch', cron: '* * * * *', tz: 'UTC' },
  // Опрос таск-менеджера Smartup (FR-DEV-04): раз в 15 минут; в ручном режиме задание ничего не делает.
  { name: 'devtasks.sync', cron: '*/15 * * * *', tz: 'UTC' },
  { name: 'ops.watch', cron: '*/5 * * * *', tz: 'UTC' },
  { name: 'maintenance.cleanup', cron: '0 3 * * *', tz: 'Asia/Tashkent' },
] as const;

const scanJob = z.object({ attachmentId: z.uuid() }).strict();
const inboundJob = z.object({ inboundId: z.uuid() }).strict();
const kbFileJob = z.object({ fileId: z.uuid() }).strict();
const kbIndexJob = z.object({ articleId: z.uuid() }).strict();
const actor = (job: string): SystemActor => ({ type: 'system', job });

/**
 * Сколько раз пытаться запуститься: база или схема pg-boss могут появиться позже процесса (выкладка, где миграции
 * идут параллельно, браузерные тесты). Паузы растут от 1 до 30 секунд, всего около восьми минут (StartOptions pg-boss).
 */
const START_ATTEMPTS = 20;
/** Событие "нет активности" (решение 5 плана M8) проверяется раз в минуту, чуть чаще расписания: запуск по расписанию его не пропускает. */
const NO_ACTIVITY_EVERY_MS = 55_000;

export interface WorkerOptions {
  connectionString?: string;
  pollingIntervalSeconds?: number;
  /** Попыток запуска: по умолчанию START_ATTEMPTS. */
  startAttempts?: number;
  /** false: без расписаний (тесты). */
  schedules?: boolean;
}

/**
 * Очереди создаёт скрипт миграций (scripts/db/pgboss.mjs). Новая версия процесса может стартовать раньше миграций
 * (выкладка, браузерные тесты): тогда она ждёт свои очереди с теми же паузами, что и запуск pg-boss, а не падает.
 */
async function waitForQueues(boss: PgBoss, attempts: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const missing: string[] = [];
    for (const name of JOB_NAMES) if (!(await boss.getQueue(name))) missing.push(name);
    if (missing.length === 0) return;
    if (attempt >= attempts) throw new Error(`нет очередей ${missing.join(', ')}: миграции не применены`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** attempt)));
  }
}

/** Память задачи automation.process между запусками: когда последний раз проверялось событие "нет активности". */
export type AutomationState = { silentCheckedAt: number };

/**
 * Один запуск задачи automation.process: разбор событий предметной области (план M8, задачи 2 и 3) и, не чаще раза
 * в минуту, событие "нет активности". Правила события применяются в транзакции события вместе с отметкой разбора,
 * после правил событие уходит адресам вебхуков, которые на него подписаны (задача 5). При остановке процесса разбор
 * прекращается между событиями.
 */
export async function automationTick(system: SystemActor, state: AutomationState, opts: { stopped: () => boolean; noActivity?: NoActivityOptions }): Promise<void> {
  const run = newRuleRun();
  const total = { processed: 0, failed: 0 };
  const drain = async () => {
    const result = await processEvents(
      system,
      async (tx, event) => {
        await handleRuleEvent(tx, event, run);
        await handleWebhookEvent(tx, event);
      },
      { stopped: opts.stopped },
    );
    total.processed += result.processed;
    total.failed += result.failed;
  };
  await drain();
  let silent = { checked: 0, applied: 0, failed: 0 };
  if (!opts.stopped() && Date.now() - state.silentCheckedAt >= NO_ACTIVITY_EVERY_MS) {
    state.silentCheckedAt = Date.now();
    // Просмотр молчащих обращений идёт после событий, ограничен по времени и перед каждой пачкой уступает разбору
    // событий (проверка вехи M8, находка I5): сообщение дежурным о P1 не ждёт конца просмотра.
    silent = await runNoActivityRules(system, { stopped: opts.stopped, ...opts.noActivity, between: drain });
    // События, которые записали срабатывания последней пачки.
    if (!opts.stopped()) await drain();
  }
  const { processed, failed } = total;
  if (failed > 0) console.info(`События: разобрано ${processed}, со сбоем ${failed}`);
  if (run.applied + run.failed + run.loops + run.paused + silent.applied + silent.failed > 0)
    console.info(
      `Правила: сработало ${run.applied + silent.applied}, без выполненных действий ${run.failed + silent.failed}, приостановлено на обращении защитой от зацикливания ${run.paused}, выключено ею ${run.loops}`,
    );
  // Письма и сообщения правил уже в очереди исходящих: отправка будится после фиксации.
  if (run.applied + silent.applied > 0) await wakeOutbox();
  // Доставки вебхуков поставлены правилами и подписками: отправка будится, только если есть что отправлять.
  if (processed + silent.applied > 0 && (await hasDueDeliveries(system))) await wakeWebhooks();
  const queue = await eventsState(system);
  logEvent(queue.lagSec > 120 ? 'warn' : queue.pending > 0 ? 'info' : 'debug', 'automation.state', queue);
}

export async function startWorker(opts: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  let stopping = false;
  const boss = new PgBoss(bossOptions(opts.connectionString ?? getEnv().DATABASE_URL_APP, 'worker'));
  boss.on('error', (error) => console.error(`Фоновый процесс: ${error.message}`));
  await boss.start({ attempts: opts.startAttempts ?? START_ATTEMPTS });
  await waitForQueues(boss, opts.startAttempts ?? START_ATTEMPTS);
  setJobQueue(createPgBossQueue(boss));
  const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };

  await boss.work('attachment.scan', { ...polling, localConcurrency: 2 }, ([job]) => timedJob('attachment.scan', async () => {
    // В задаче только идентификатор вложения: остальное берётся из базы.
    const { attachmentId } = scanJob.parse(job?.data);
    try {
      await scanAttachment(actor('attachment.scan'), attachmentId);
    } catch (error) {
      // Строки уже нет (удалил обход): делать нечего, повтор не нужен.
      if (isHdtError(error) && error.code === 'not_found') return;
      throw error;
    }
  }));
  await boss.work('kb.scan', { ...polling, localConcurrency: 2 }, ([job]) => timedJob('kb.scan', async () => {
    // Изображение решения (план M5, задача 3): в задаче только идентификатор файла.
    const { fileId } = kbFileJob.parse(job?.data);
    await scanSolutionFile(actor('kb.scan'), fileId);
  }));
  await boss.work('kb.index', polling, ([job]) => timedJob('kb.index', async () => {
    // Публикация ставит задачу после фиксации (план M5, задача 4). Строку индекса и вектор пишет задача 9; до неё
    // задача только принимает идентификатор и ничего не меняет, ночная сверка kb.reconcile задачи 9 найдёт опубликованное без строки индекса.
    kbIndexJob.parse(job?.data);
  }));
  await boss.work('email.inbound', polling, ([job]) => timedJob('email.inbound', async () => {
    // В задаче только идентификатор письма: сведения о нём в базе, текст и файлы у почтового сервиса.
    const { inboundId } = inboundJob.parse(job?.data);
    await intakeEmail(actor('email.inbound'), inboundId);
  }));
  await boss.work('attachment.sweep', polling, () => timedJob('attachment.sweep', async () => {
    const { requeued, removed, failed } = await sweepAttachments(actor('attachment.sweep'));
    if (requeued > 0 || removed > 0 || failed > 0)
      console.info(`Обход загрузок: снова на проверке ${requeued}, удалено ${removed}, проверка не прошла за сутки ${failed}`);
  }));
  await boss.work('tickets.minute', polling, () => timedJob('tickets.minute', async () => {
    const { breached, unsnoozed, closed, refreshed, presenceRemoved, reminded } = await ticketsMinute(actor('tickets.minute'));
    if (breached + unsnoozed + closed + refreshed + reminded > 0)
      console.info(
        `Обращения: нарушено сроков ${breached}, вернулось отложенных ${unsnoozed}, напомнили клиентам ${reminded}, закрыто автоматически ${closed}, досчитано сроков ${refreshed}`,
      );
    void presenceRemoved;
    // Письма, разбор которых не встал в очередь или исчерпал повторы, ставятся снова (итоговая проверка M4).
    const requeued = await requeueStaleInbound(actor('email.sweep'));
    if (requeued > 0) console.info(`Входящие письма: снова на разборе ${requeued}`);
  }));
  await boss.work('outbox.dispatch', polling, () => timedJob('outbox.dispatch', async () => {
    // При остановке процесса запуск прекращает работу между письмами: захваченные строки не ждут 5 минут.
    const { sent, failed, skipped } = await dispatchOutbox(actor('outbox.dispatch'), new Date(), undefined, undefined, { stopped: () => stopping });
    if (sent + failed + skipped > 0) console.info(`Очередь писем: отправлено ${sent}, не отправлено ${failed}, без адреса ${skipped}`);
    // Состояние очереди для наблюдения: ждущие, не отправленные, задержка. Пустая очередь пишется только на debug.
    const state = await outboxState(actor('outbox.dispatch'), new Date());
    logEvent(state.failed > 0 || state.lagSec > 60 ? 'warn' : state.queued > 0 ? 'info' : 'debug', 'outbox.state', state);
  }));
  // Событие "нет активности" проверяется не чаще раза в минуту: задача идёт и по расписанию, и по сигналу после каждого изменения.
  const automation: AutomationState = { silentCheckedAt: 0 };
  await boss.work('automation.process', polling, () => timedJob('automation.process', () => automationTick(actor('automation.process'), automation, { stopped: () => stopping })));
  await boss.work('webhooks.dispatch', polling, () => timedJob('webhooks.dispatch', async () => {
    // Исходящие вебхуки (план M8, задача 5): повторы ведёт сама очередь доставок. При остановке процесса запуск
    // прекращает работу между доставками.
    const { sent, failed, retried, cancelled } = await dispatchWebhooks(actor('webhooks.dispatch'), { stopped: () => stopping });
    if (sent + failed + retried + cancelled > 0) console.info(`Вебхуки: доставлено ${sent}, ждут повтора ${retried}, не доставлено ${failed}, отменено ${cancelled}`);
  }));
  await boss.work('devtasks.sync', polling, () => timedJob('devtasks.sync', async () => {
    // Статусы задач разработки из таск-менеджера Smartup (план M8, задача 8): только в режиме API. Сбой чтения одной
    // задачи остальным не мешает; при остановке процесса опрос прекращается между задачами.
    const { checked, updated, failed, reminded } = await syncDevTasks(actor('devtasks.sync'), { stopped: () => stopping });
    if (checked > 0) console.info(`Задачи разработки: сверено ${checked}, изменилось ${updated}, не прочитано ${failed}, напоминаний о закрытии ${reminded}`);
    // Письма исполнителям о закрытых задачах уже в очереди исходящих.
    if (reminded > 0) await wakeOutbox();
  }));
  await boss.work('ops.watch', polling, () => timedJob('ops.watch', async () => {
    const sent = await opsWatch(actor('ops.watch'));
    if (sent.length > 0) logEvent('warn', 'ops.alerts_sent', { codes: sent });
  }));
  await boss.work('maintenance.cleanup', polling, () => timedJob('maintenance.cleanup', async () => {
    const system = actor('maintenance.cleanup');
    const limits = await cleanupRateLimits();
    const updates = await cleanupTelegramUpdates(system);
    const { sessions, verifications, links } = await cleanupAuthRows(system);
    const notices = await cleanupNotifications(system, new Date());
    const sentMail = await cleanupOutbox(system);
    const letters = await cleanupInbound(system);
    // Журнал аудита хранится 3 года (ТЗ 14.6, решение владельца 24.11.2026).
    // Разобранные события предметной области хранятся 30 суток (план M8, задача 2).
    const events = await cleanupDomainEvents(system);
    if (events > 0) console.info(`Ночная очистка: разобранные события старше 30 суток ${events}`);
    // Срабатывания правил автоматизации хранятся 90 суток (план M8, задача 3).
    const runs = await cleanupRuleRuns(system);
    if (runs > 0) console.info(`Ночная очистка: срабатывания правил старше 90 суток ${runs}`);
    // Журнал доставок вебхуков хранится 30 суток (план M8, решение 10).
    const hooks = await cleanupWebhookDeliveries(system);
    if (hooks > 0) console.info(`Ночная очистка: доставки вебхуков старше 30 суток ${hooks}`);
    const audit = await cleanupAudit(system);
    if (audit > 0) console.info(`Ночная очистка: записи журнала аудита старше 3 лет ${audit}`);
    console.info(
      `Ночная очистка: счётчики частоты ${limits}, события Telegram ${updates}, сессии ${sessions}, одноразовые значения входа ${verifications}, ссылки и коды входа ${links}, прочитанные уведомления ${notices}, отправленные письма очереди ${sentMail}, разобранные входящие письма ${letters}`,
    );
  }));
  if (opts.schedules !== false) for (const s of SCHEDULES) await boss.schedule(s.name, s.cron, null, { tz: s.tz });

  return {
    async stop() {
      stopping = true;
      setJobQueue(null);
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}

if (import.meta.main) {
  try {
    // Неверное окружение останавливает процесс сразу, как и портал (src/instrumentation.ts).
    const env = getEnv();
    configureLog({ level: env.LOG_LEVEL, json: (env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json' });
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
