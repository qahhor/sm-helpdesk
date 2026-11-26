import 'server-only';
import { type ConstructorOptions, PgBoss } from 'pg-boss';
import { env } from '@/env';

// Постановка фоновых задач (раздел 11.10, решение 0028). Очередь pg-boss в схеме pgboss той же базы, под ролью hub_app.
// В задачах только идентификаторы, без текстов клиентов. Задачи идемпотентны: повтор безопасен.
// Схему и очереди создаёт скрипт миграций (scripts/db/pgboss.mjs): у hub_app нет прав на объекты схемы.

export const JOB_NAMES = [
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
  'search.reconcile',
  'search.sync',
  'tickets.minute',
  'webhooks.dispatch',
] as const;
export type JobName = (typeof JOB_NAMES)[number];
export type JobData = Record<string, string | number | boolean | null>;

export const PGBOSS_SCHEMA = 'pgboss';

export interface JobQueue {
  send(name: JobName, data: JobData): Promise<void>;
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
    async send(name, data) {
      // Одна задача на файл или входящее письмо (exclusive); на решение одна ждущая и одна выполняемая (stately, kb.index).
      const key = [data.attachmentId, data.inboundId, data.fileId, data.articleId, data.ideaId].find((value): value is string => typeof value === 'string');
      await boss.send(name, data, key ? { singletonKey: key } : {});
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
export async function enqueue(name: JobName, data: JobData): Promise<void> {
  try {
    await (override ?? configured ?? (await portalQueue())).send(name, data);
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
  readonly sent: { name: JobName; data: JobData }[] = [];

  async send(name: JobName, data: JobData): Promise<void> {
    this.sent.push({ name, data });
  }
}
