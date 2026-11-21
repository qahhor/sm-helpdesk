import 'server-only';

// Постановка фоновых задач (раздел 11.10). Очередь подменяемая: тесты ставят очередь в памяти,
// фоновый процесс берёт задачи из pg-boss (план M2, задача 7). Задачи идемпотентны: повтор безопасен.

export const JOB_NAMES = ['attachment.scan'] as const;
export type JobName = (typeof JOB_NAMES)[number];
export type JobData = Record<string, string | number | boolean | null>;

export interface JobQueue {
  send(name: JobName, data: JobData): Promise<void>;
}

let override: JobQueue | null = null;
let configured: JobQueue | null = null;

/** Ставит задачу. Без настроенной очереди бросает ошибку: задача не должна теряться молча. */
export async function enqueue(name: JobName, data: JobData): Promise<void> {
  const queue = override ?? configured;
  if (!queue) throw new Error('очередь фоновых задач не настроена');
  await queue.send(name, data);
}

/** Настоящая очередь портала. */
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
