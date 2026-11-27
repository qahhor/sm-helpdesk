import 'server-only';
import { type ConstructorOptions, PgBoss } from 'pg-boss';
import { env } from '@/env';

// Постановка фоновых задач (раздел 11.10, решение 0028). Очередь pg-boss в схеме pgboss той же базы, под ролью hub_app.
// В задачах только идентификаторы, без текстов клиентов. Задачи идемпотентны: повтор безопасен.
// Схему и очереди создаёт скрипт миграций (scripts/db/pgboss.mjs): у hub_app нет прав на объекты схемы.

export const JOB_NAMES = [
  // AI-сотрудник (веха M8b, задачи 8 и 9): ночная очистка, отправка событий раз в минуту, всплеск сигнатуры раз в 5 минут.
  'agent.cleanup',
  'agent.events_dispatch',
  'agent.spikes',
  // AI первой линии (веха M5b): пределы расходов раз в 10 минут, ответ первой линии, сторожевая проверка, разбор без
  // ответа и ночная проверка доли принятых предложений разбора.
  'ai.budget',
  // Кандидаты в решения (веха M5c, задача 9): обход раз в 15 минут, черновик по обращению, ночной досчёт векторов.
  'ai.candidate',
  'ai.candidates_embed',
  'ai.candidates_sweep',
  'ai.first_line',
  'ai.message_translation',
  'ai.thanks',
  'ai.triage',
  'ai.triage_review',
  'ai.watchdog',
  'announcements.translate',
  'attachment.scan',
  'attachment.sweep',
  'automation.process',
  'devtasks.sync',
  'email.inbound',
  'ideas.cycle',
  'ideas.index',
  'ideas.moderation_digest',
  'ideas.scan',
  'ideas.translate',
  'kb.draft',
  'kb.index',
  'kb.reconcile',
  'kb.scan',
  'kb.translate',
  'maintenance.cleanup',
  'ops.heartbeat',
  'ops.watch',
  'outbox.dispatch',
  // Известные проблемы (веха M5c): машинный перевод публичного текста.
  'problems.broadcast',
  'problems.translate',
  'search.reconcile',
  'search.sync',
  'tickets.minute',
  'webhooks.dispatch',
] as const;
export type JobName = (typeof JOB_NAMES)[number];
export type JobData = Record<string, string | number | boolean | null>;

export const PGBOSS_SCHEMA = 'pgboss';

/** startAfterSeconds: отложенный старт (сторожевая проверка помощника через 60 секунд, план M5b, решение 5). */
export type JobOptions = { startAfterSeconds?: number };

export interface JobQueue {
  send(name: JobName, data: JobData, opts?: JobOptions): Promise<void>;
}

/**
 * Настройки pg-boss под hub_app. Без миграций, без перестройки индексов и создания схемы: на это нужны права
 * владельца. Портал (sender) только ставит задачи; фоновый процесс (worker) ещё обслуживает очередь и расписания.
 */
export function bossOptions(connectionString: string, role: 'sender' | 'worker'): ConstructorOptions {
  const common: ConstructorOptions = {
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: `hub-${role}`,
    migrate: false,
    createSchema: false,
    reindex: false,
  };
  return role === 'sender'
    ? { ...common, supervise: false, schedule: false, registerInstance: false, max: 2 }
    : { ...common, supervise: true, schedule: true, instanceName: 'worker', max: 5 };
}

/** Очередь поверх запущенного pg-boss. Ключ singletonKey: для одного объекта не больше одной задачи (политики exclusive и stately). */
export function createPgBossQueue(boss: PgBoss): JobQueue {
  return {
    async send(name, data, opts) {
      // Одна задача на файл или входящее письмо (exclusive); на решение одна ждущая и одна выполняемая (stately, kb.index).
      // Первая линия и разбор: одна ждущая и одна выполняемая на обращение (stately, план M5b, решения 5, 6).
      const key = [data.attachmentId, data.inboundId, data.fileId, data.articleId, data.ideaId, data.translationId, data.messageId, name === 'problems.broadcast' ? data.broadcastId : undefined, name === 'ai.first_line' || name === 'ai.triage' ? data.ticketId : undefined].find(
        (value): value is string => typeof value === 'string',
      );
      await boss.send(name, data, { ...(key ? { singletonKey: key } : {}), ...(opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}) });
    },
  };
}

let override: JobQueue | null = null;
let configured: JobQueue | null = null;
let sender: Promise<JobQueue> | null = null;

/** Очередь портала: свой небольшой pg-boss, запускается при первой постановке. */
function portalQueue(): Promise<JobQueue> {
  sender ??= (async () => {
    const boss = new PgBoss(bossOptions(env.DATABASE_URL_APP, 'sender'));
    boss.on('error', (error) => console.error(`Очередь задач: ${error.message}`));
    await boss.start();
    return createPgBossQueue(boss);
  })().catch((error: unknown) => {
    sender = null;
    throw error;
  });
  return sender;
}

/**
 * Ставит задачу. Ошибка постановки пишется в журнал процесса и не роняет запрос: зависшую загрузку
 * найдёт обход attachment.sweep раз в минуту. В журнал попадают только имя задачи и идентификатор.
 */
export async function enqueue(name: JobName, data: JobData, opts?: JobOptions): Promise<void> {
  try {
    await (override ?? configured ?? (await portalQueue())).send(name, data, opts);
  } catch (error) {
    const id = typeof data.attachmentId === 'string' ? ` ${data.attachmentId}` : '';
    console.error(`Задача ${name}${id} не поставлена: ${error instanceof Error ? error.message : 'ошибка'}`);
  }
}

/** Очередь процесса: фоновый процесс ставит задачи через свой pg-boss. */
export function setJobQueue(queue: JobQueue | null): void {
  configured = queue;
}

/** Тесты подменяют очередь (null возвращает настоящую). */
export function setJobQueueForTests(queue: JobQueue | null): void {
  override = queue;
}

/** Очередь в памяти для тестов. */
export class MemoryJobQueue implements JobQueue {
  readonly sent: { name: JobName; data: JobData; opts?: JobOptions }[] = [];

  async send(name: JobName, data: JobData, opts?: JobOptions): Promise<void> {
    this.sent.push({ name, data, opts });
  }
}
