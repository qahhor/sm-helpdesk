import '@/wiring';
import { PgBoss } from 'pg-boss';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { getEnv, parseAiEnv } from '@/env';
import { configureLog, logEvent, runJobSteps, timedJob } from '@/lib/log';
import { beatWorker, bossOptions, cleanupAudit, cleanupDomainEvents, cleanupHostMarks, cleanupRateLimits, createPgBossQueue, eventsState, JOB_NAMES, processEvents, setJobQueue } from '@/modules/hdc/api';
import { cleanupInbound, cleanupOutbox, cleanupTelegramUpdates } from '@/modules/hdn/api/maintenance';
import { cleanupNotifications } from '@/modules/hdn/api/notifications';
import { requeueStaleInbound } from '@/modules/hdn/api/inbound';
import { runAiBudget } from '@/modules/hda/api/budget';
import { runFirstLineJob, runWatchdogJob } from '@/modules/hda/api/first-line';
import { runTriageJob, runTriageReview } from '@/modules/hda/api/triage-jobs';
import { cleanupMessageTranslations, runMessageTranslationJob, runThanksJob } from '@/modules/hda/api/message-ai';
import { runDraftJob, runTranslationJob } from '@/modules/hdk/api/ai-jobs';
import { scanSolutionFile, sweepSolutionFiles } from '@/modules/hdk/api/files';
import { runIdeaIndexJob, runIdeaTranslationJob, scanIdeaAttachment } from '@/modules/hdi/api/jobs';
import { sweepIdeaUploads } from '@/modules/hdi/api/uploads';
import { runModerationDigest } from '@/modules/hdi/api/notices';
import { runIdeaCycle } from '@/modules/hdi/api/cycle-job';
import { runAnnouncementTranslationJob, runProblemTranslationJob } from '@/modules/hdp/api/translate-jobs';
import { runBroadcastJob, runBroadcastTranslationJob, sweepBroadcasts } from '@/modules/hdp/api/broadcast-jobs';
import { reconcileSearchIndex, runIndexJob } from '@/modules/hdk/api/search-jobs';
import { cleanupSuggestMisses } from '@/modules/hdk/api/misses';
import { repairTicketSignatures } from '@/modules/hdk/api/signatures';
import { dispatchOutbox, outboxState, wakeOutbox } from '@/modules/hdn/api/outbox';
import { intakeEmail } from '@/modules/hdt/api/email-intake';
import { runClientDataRetention } from '@/modules/hdt/api/retention';
import { isHdtError, scanAttachment, sweepAttachments, ticketsMinute } from '@/modules/hdt/api/jobs';
import { closeConnections } from '@/modules/hdu/api/connections';
import { cleanupRuleRuns, handleRuleEvent, newRuleRun, type NoActivityOptions, runNoActivityRules } from '@/modules/hdw/api/engine';
import { runCandidateJob, runCandidatesEmbed, runCandidatesSweep } from '@/modules/hda/api/candidates';
import { cleanupAgentData, dispatchAgentEvents, handleAgentEvent, runSpikeDetection } from '@/modules/hda/api/agent-jobs';
import { markAnalysisTimeouts } from '@/modules/hda/api/code-analysis';
import { sendTeamChatMessages } from '@/modules/hda/api/digests';
import { syncDevTasks } from '@/modules/hdw/api/dev-task-jobs';
import { cleanupWebhookDeliveries, dispatchWebhooks, handleWebhookEvent, hasDueDeliveries, wakeWebhooks } from '@/modules/hdw/api/webhook-jobs';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';
import { opsWatch } from './ops-watch';
import { registerSearch } from './search';
import { searchReconcile, searchSyncTick } from './search-jobs';
import { withTicketsPeople } from '@/modules/hdt/api/notice-identity';

// Фоновый процесс портала (раздел 11.10, решение 0028): задачи pg-boss под ролью hub_app.
// Собирается в один файл dist/worker.mjs (scripts/build-cli.mjs). В образе: node worker.mjs.
// Модулем не является и, как страницы, берёт у модулей только слой api: узкие файлы каталога api/,
// как команда консоли, чтобы в сборку не попали страницы и Next.js.

/** Расписания: обход загрузок, задача обращений, отправка очереди писем, разбор событий и правила, отправка вебхуков раз в минуту, опрос таск-менеджера раз в 15 минут, ночная очистка в 03:00 , сверка индекса решений в 03:30, сводка модерации идей в 09:30 и отбор месяца 1-го числа в 09:00 по Ташкенту (решение 0023). */
export const SCHEDULES = [
  { name: 'attachment.sweep', cron: '* * * * *', tz: 'UTC' },
  { name: 'tickets.minute', cron: '* * * * *', tz: 'UTC' },
  // Пределы расходов на AI (план M5b, решение 11): раз в 10 минут.
  // Всплеск сигнатуры для AI-сотрудника (веха M8b, задача 8, решение 25): раз в 5 минут.
  { name: 'agent.spikes', cron: '*/5 * * * *', tz: 'UTC' },
  // События для AI-сотрудника (задача 9, решение 26): отправка раз в минуту, ночная очистка в 03:40 по Ташкенту.
  { name: 'agent.events_dispatch', cron: '* * * * *', tz: 'UTC' },
  { name: 'agent.cleanup', cron: '40 3 * * *', tz: 'Asia/Tashkent' },
  { name: 'ai.budget', cron: '*/10 * * * *', tz: 'UTC' },
  // Сторожевая проверка помощника (план M5b, решение 5): раз в минуту по всем обращениям у помощника.
  { name: 'ai.watchdog', cron: '* * * * *', tz: 'UTC' },
  { name: 'outbox.dispatch', cron: '* * * * *', tz: 'UTC' },
  { name: 'automation.process', cron: '* * * * *', tz: 'UTC' },
  { name: 'webhooks.dispatch', cron: '* * * * *', tz: 'UTC' },
  // Опрос таск-менеджера Smartup (FR-DEV-04): раз в 15 минут; в ручном режиме задание ничего не делает.
  { name: 'devtasks.sync', cron: '*/15 * * * *', tz: 'UTC' },
  { name: 'ops.watch', cron: '*/5 * * * *', tz: 'UTC' },
  // Отметка "фоновый процесс жив" для /api/ready/worker (план подготовки M9, решение 5).
  { name: 'ops.heartbeat', cron: '* * * * *', tz: 'UTC' },
  { name: 'maintenance.cleanup', cron: '0 3 * * *', tz: 'Asia/Tashkent' },
  // Сроки хранения данных клиентов (ТЗ 14.6; волна 7, T2): ночью после очистки. Выключена настройкой
  // retention.client_data_enabled: без неё задача только считает (пробный прогон).
  { name: 'retention.client_data', cron: '15 3 * * *', tz: 'Asia/Tashkent' },
  // Сверка поискового индекса подсказки (план M5, задача 9): после ночной очистки.
  { name: 'kb.reconcile', cron: '30 3 * * *', tz: 'Asia/Tashkent' },
  // Доля принятых предложений разбора за месяц (план M5b, задача 7, FR-TRI-04): ночью после сверки индекса.
  { name: 'ai.triage_review', cron: '45 3 * * *', tz: 'Asia/Tashkent' },
  // Кандидаты в решения (план M5c, решения 26, 28): обход раз в 15 минут, досчёт векторов ночью.
  { name: 'ai.candidates_sweep', cron: '*/15 * * * *', tz: 'UTC' },
  { name: 'ai.candidates_embed', cron: '20 4 * * *', tz: 'Asia/Tashkent' },
  // Сводка модерации идей роли product (план M7, задача 8, решение 15): раз в день в 09:30 по Ташкенту.
  { name: 'ideas.moderation_digest', cron: '30 9 * * *', tz: 'Asia/Tashkent' },
  // Отбор месяца (план M7, задача 9, решение 16): 1-го числа в 09:00 по Ташкенту.
  { name: 'ideas.cycle', cron: '0 9 1 * *', tz: 'Asia/Tashkent' },
  // Индекс поиска (план W6, решения 11 и 12): разбор очереди раз в минуту, сверка в 04:10 по Ташкенту.
  { name: 'search.sync', cron: '* * * * *', tz: 'UTC' },
  { name: 'search.reconcile', cron: '10 4 * * *', tz: 'Asia/Tashkent' },
] as const;

const scanJob = z.object({ attachmentId: z.uuid() }).strict();
const inboundJob = z.object({ inboundId: z.uuid() }).strict();
const kbFileJob = z.object({ fileId: z.uuid() }).strict();
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
        // События для AI-сотрудника (веха M8b, задача 9): своя точка сохранения, сбой не откатывает событие.
        await handleAgentEvent(tx, event);
      },
      // Получатели уведомлений обращения читаются до транзакции события (проверка качества, Q2).
      { stopped: opts.stopped, around: (ticketId, run) => withTicketsPeople(system, [ticketId], run) },
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
  // Отметка при запуске: после выкладки /api/ready/worker не отвечает 503 до первой минуты расписания.
  await beatWorker(actor('ops.heartbeat'));
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
  await boss.work('ideas.scan', { ...polling, localConcurrency: 2 }, ([job]) => timedJob('ideas.scan', async () => {
    // Изображение идеи (план M7, решение 10): в задаче только идентификатор вложения.
    await scanIdeaAttachment(actor('ideas.scan'), job?.data);
  }));
  await boss.work('ideas.index', polling, ([job]) => timedJob('ideas.index', async () => {
    // Строки индекса похожих идей и векторы (план M7, задача 3): как kb.index, повтор при недоступном сервисе векторов.
    await runIdeaIndexJob(actor('ideas.index'), job?.data);
  }));
  await boss.work('ideas.translate', polling, ([job]) => timedJob('ideas.translate', async () => {
    // Машинный перевод идеи (план M7, задача 4): модель вызывает только фоновый процесс, сбой повторяет pg-boss.
    await runIdeaTranslationJob(actor('ideas.translate'), job?.data);
  }));
  await boss.work('problems.translate', polling, ([job]) => timedJob('problems.translate', async () => {
    // Машинный перевод публичного текста известной проблемы (план M5c, задача 2) или рассылки (задача 5): клиенту не
    // виден, пока сотрудник его не принял.
    const data = job?.data as Record<string, unknown> | undefined;
    if (data && 'broadcastId' in data) await runBroadcastTranslationJob(actor('problems.translate'), data);
    else await runProblemTranslationJob(actor('problems.translate'), data);
  }));
  await boss.work('announcements.translate', polling, ([job]) => timedJob('announcements.translate', async () => {
    // Машинный перевод объявления (план M5c, задача 6): клиенту не виден, пока сотрудник его не принял.
    await runAnnouncementTranslationJob(actor('announcements.translate'), job?.data);
  }));
  await boss.work('problems.broadcast', polling, ([job]) => timedJob('problems.broadcast', async () => {
    // Рассылка по известной проблеме (план M5c, задача 5, решение 18): по одному обращению за транзакцию, без дублей.
    await runBroadcastJob(actor('problems.broadcast'), job?.data);
  }));
  await boss.work('ideas.moderation_digest', polling, () => timedJob('ideas.moderation_digest', async () => {
    await runModerationDigest(actor('ideas.moderation_digest'), new Date());
  }));
  await boss.work('ideas.cycle', polling, () => timedJob('ideas.cycle', async () => {
    // Снимок пятёрки за месяц (план M7, задача 9): время задания, повтор в тот же месяц ничего не меняет.
    const result = await runIdeaCycle(actor('ideas.cycle'), new Date());
    if (result.status === 'created') console.info(`Отбор месяца ${result.cycle}: в пятёрке ${result.shortlist.length}, закрыто без выбора ${result.lapsed}`);
  }));
  await boss.work('kb.index', polling, ([job]) => timedJob('kb.index', async () => {
    // Строки поискового индекса и векторы решения (план M5, задача 9). Сервис векторов недоступен: строки с текстом уже
    // записаны, задача бросает ошибку, pg-boss повторяет её; пропущенное найдёт ночная сверка kb.reconcile.
    await runIndexJob(actor('kb.index'), job?.data);
  }));
  await boss.work('retention.client_data', polling, () => timedJob('retention.client_data', async () => {
    const report = await runClientDataRetention(actor('retention.client_data'));
    console.info(`Сроки хранения (${report.mode === 'delete' ? 'удаление' : 'пробный прогон'}): файлов к удалению ${report.attachmentsDue}, удалено ${report.attachmentsExpired}; организаций с истёкшим сроком ${report.orgsDue}, их обращений ${report.ticketsDue}`);
  }));
  await boss.work('kb.reconcile', polling, () => timedJob('kb.reconcile', async () => {
    const { articles, failed, deflections } = await reconcileSearchIndex(actor('kb.reconcile'));
    if (articles + deflections > 0) console.info(`Сверка индекса решений: переиндексировано ${articles}, без вектора осталось ${failed}, исходов подсказки старше 13 месяцев удалено ${deflections}`);
    // Потерянные сигнатуры обращений последних трёх суток (0057, M7m).
    const signatures = await repairTicketSignatures(actor('kb.reconcile'));
    if (signatures.repaired > 0) console.info(`Сверка сигнатур: дописано ${signatures.repaired} из ${signatures.checked}`);
  }));
  // Номер попытки и предел повторов нужны задачам модели: failed ставится только после последней попытки (0057).
  await boss.work('kb.translate', { ...polling, includeMetadata: true }, ([job]) => timedJob('kb.translate', async () => {
    // Машинный перевод решения (план M5, задача 6): модель вызывает только фоновый процесс (решение 3).
    await runTranslationJob(actor('kb.translate'), job?.data, job ? { retryCount: job.retryCount, retryLimit: job.retryLimit } : undefined);
  }));
  await boss.work('kb.draft', { ...polling, includeMetadata: true }, ([job]) => timedJob('kb.draft', async () => {
    // Черновик решения из закрытого обращения (план M5, задача 7): модель вызывает только фоновый процесс.
    await runDraftJob(actor('kb.draft'), job?.data, job ? { retryCount: job.retryCount, retryLimit: job.retryLimit } : undefined);
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
    // Изображения решений и идей (проверка качества, Q5): тот же обход зависших проверок.
    const kb = await sweepSolutionFiles(actor('attachment.sweep'));
    const ideas = await sweepIdeaUploads(actor('attachment.sweep'));
    if (kb.requeued + kb.failed + ideas.requeued + ideas.failed > 0)
      console.info(`Обход изображений: решения снова на проверке ${kb.requeued}, не приняты ${kb.failed}; идеи снова на проверке ${ideas.requeued}, не приняты ${ideas.failed}`);
  }));
  await boss.work('ai.budget', polling, () => timedJob('ai.budget', async () => {
    const result = await runAiBudget(actor('ai.budget'));
    // Машинные переводы сообщений живут 24 часа (план M5b, решение 24): удаляются тем же заданием раз в 10 минут.
    const removed = await cleanupMessageTranslations(actor('ai.budget'));
    if (removed > 0) console.info(`AI: удалено переводов сообщений старше суток ${removed}`);
    if (result.orgsCut > 0 || result.allCut) console.info(`AI: расход ${result.spentUsd} из ${result.budgetUsd} долларов, отключено организаций ${result.orgsCut}${result.allCut ? ', помощник отключён для всех' : ''}`);
  }));
  await boss.work('ai.first_line', { ...polling, localConcurrency: 2 }, ([job]) => timedJob('ai.first_line', async () => {
    // Ответ первой линии (план M5b, задача 4): в задании только идентификатор обращения. Сбой внутри ведёт к передаче.
    await runFirstLineJob(actor('ai.first_line'), job?.data);
  }));
  await boss.work('ai.message_translation', polling, ([job]) => timedJob('ai.message_translation', async () => {
    // Перевод сообщения клиента для сотрудника (план M5b, задача 9): в задании только идентификатор строки перевода.
    await runMessageTranslationJob(actor('ai.message_translation'), job?.data);
  }));
  await boss.work('ai.thanks', polling, ([job]) => timedJob('ai.thanks', async () => {
    // Уточнение благодарности (FR-TK-14, решение 24): модель может только открыть обращение заново.
    await runThanksJob(actor('ai.thanks'), job?.data);
  }));
  await boss.work('ai.triage', polling, ([job]) => timedJob('ai.triage', async () => {
    // Разбор без ответа помощника (план M5b, решение 6): в задании только идентификатор обращения.
    await runTriageJob(actor('ai.triage'), job?.data);
  }));
  await boss.work('ai.triage_review', polling, () => timedJob('ai.triage_review', async () => {
    const off = await runTriageReview(actor('ai.triage_review'));
    if (off.length > 0) console.info(`AI: отключены предложения разбора полей ${off.join(', ')}`);
  }));
  await boss.work('agent.spikes', polling, () => timedJob('agent.spikes', async () => {
    const { detected } = await runSpikeDetection(actor('agent.spikes'));
    if (detected > 0) console.info(`AI-сотрудник: всплесков сигнатур найдено ${detected}`);
  }));
  // Шаги минутной задачи независимы (независимая проверка M8c, находка I4): сбой отправки событий не держит срок анализа.
  await boss.work('agent.events_dispatch', polling, () => timedJob('agent.events_dispatch', () => runJobSteps('agent.events_dispatch', [
    {
      // Срок ответа на "Разобрать по коду" (веха M8c, FR-CODE-10): через 10 минут запрос "анализ не выполнен". Шаг идёт
      // первым (проверка качества, Q4): он быстрый и не должен ждать медленного приёмника событий.
      step: 'analysis_timeouts',
      run: async () => {
        const analysis = await markAnalysisTimeouts(actor('agent.events_dispatch'));
        if (analysis.timedOut > 0) console.info(`AI-сотрудник: анализов по коду без ответа ${analysis.timedOut}`);
      },
    },
    {
      step: 'events',
      run: async () => {
        const { sent, failed } = await dispatchAgentEvents(actor('agent.events_dispatch'));
        if (sent + failed > 0) console.info(`AI-сотрудник: событий отправлено ${sent}, неудачно ${failed}`);
      },
    },
    {
      // Сообщения в чат команды по новым сводкам (задача 10, решение 24): та же минутная задача.
      step: 'team_chat',
      run: async () => {
        const chat = await sendTeamChatMessages(actor('agent.events_dispatch'));
        if (chat.sent > 0) console.info(`AI-сотрудник: сообщений в чат команды ${chat.sent}`);
      },
    },
  ])));
  await boss.work('agent.cleanup', polling, () => timedJob('agent.cleanup', async () => {
    const removed = await cleanupAgentData(actor('agent.cleanup'));
    console.info(`AI-сотрудник: удалено строк журнала вызовов ${removed.calls}, событий ${removed.events}, токенов запуска ${removed.runTokens}`);
  }));
  await boss.work('ai.candidates_sweep', polling, () => timedJob('ai.candidates_sweep', async () => {
    const { queued } = await runCandidatesSweep(actor('ai.candidates_sweep'));
    if (queued > 0) console.info(`AI: кандидатов в решения поставлено ${queued}`);
  }));
  await boss.work('ai.candidate', polling, ([job]) => timedJob('ai.candidate', async () => {
    // Кандидат по закрытому обращению (план M5c, задача 9): в задании только идентификатор обращения.
    await runCandidateJob(actor('ai.candidate'), job?.data);
  }));
  await boss.work('ai.candidates_embed', polling, () => timedJob('ai.candidates_embed', async () => {
    const { embedded, merged } = await runCandidatesEmbed(actor('ai.candidates_embed'));
    if (embedded > 0) console.info(`AI: векторов кандидатов досчитано ${embedded}, склеено ${merged}`);
  }));
  await boss.work('ai.watchdog', polling, ([job]) => timedJob('ai.watchdog', async () => {
    // Через 60 секунд после создания или ответа клиента (с обращением) и раз в минуту по расписанию (без него).
    const handed = await runWatchdogJob(actor('ai.watchdog'), job?.data);
    if (handed > 0) console.info(`AI: сторож передал сотрудникам обращений ${handed}`);
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
    // Рассылки по известным проблемам, которые не дошли до конца за 10 минут, ставятся снова (проверка качества, Q1).
    const broadcasts = await sweepBroadcasts(actor('problems.broadcast'));
    if (broadcasts.requeued > 0) console.info(`Известные проблемы: рассылок снова на отправке ${broadcasts.requeued}`);
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
  // Индекс поиска (план W6): построители модулей, разбор очереди и ночная сверка. Без Typesense очередь очищается.
  registerSearch();
  await boss.work('search.sync', polling, () => timedJob('search.sync', () => searchSyncTick(actor('search.sync'), { stopped: () => stopping })));
  await boss.work('search.reconcile', polling, () => timedJob('search.reconcile', () => searchReconcile(actor('search.reconcile'))));
  // Отметка раз в минуту идёт через очередь, как все задачи: она показывает, что процесс берёт задачи, а не только жив.
  await boss.work('ops.heartbeat', polling, () => beatWorker(actor('ops.heartbeat')));
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
    // Тексты запросов подсказки без результата хранятся 90 суток (план W6, ответ владельца 0070, пункт 5).
    const misses = await cleanupSuggestMisses(system);
    if (misses > 0) console.info(`Ночная очистка: запросы подсказки без результата старше 90 суток ${misses}`);
    // Отметки ресурсов снятых серверов хранятся 7 суток (независимая проверка M9, M2; решение 0145).
    const hosts = await cleanupHostMarks(system);
    if (hosts > 0) console.info(`Ночная очистка: отметки ресурсов серверов старше 7 суток ${hosts}`);
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
    // Ключ Claude есть только у фонового процесса (план M5, решение 3): неверный набор останавливает процесс сразу.
    const ai = parseAiEnv(process.env);
    configureLog({ level: env.LOG_LEVEL, json: (env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json' });
    const worker = await startWorker();
    console.info(`Фоновый процесс запущен, модель: ${ai.mode === 'anthropic' ? 'Claude API' : ai.mode === 'stub' ? 'заглушка' : 'без AI'}`);
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
