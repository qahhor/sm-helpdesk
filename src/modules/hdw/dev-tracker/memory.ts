import type { DevTracker, DevTrackerTask, DevTrackerTaskInput } from './types';

// Модуль hdw: заглушка DevTracker в памяти для тестов и локальной разработки (ТЗ 11.11: у каждого интерфейса есть
// заглушка). Запоминает созданные задачи, отдаёт их по номеру, умеет "упасть" по команде теста.

export type MemoryDevTracker = DevTracker & {
  /** Что портал прислал при создании задач, по порядку. */
  readonly created: DevTrackerTaskInput[];
  /** Задать или сменить задачу, как будто её изменили в таск-менеджере. */
  set(task: DevTrackerTask): void;
  /** Следующие вызовы падают, как при недоступном таск-менеджере. */
  failing: boolean;
};

export function createMemoryDevTracker(opts: { baseUrl?: string } = {}): MemoryDevTracker {
  const baseUrl = opts.baseUrl ?? 'https://tracker.smartup.example';
  const tasks = new Map<string, DevTrackerTask>();
  const created: DevTrackerTaskInput[] = [];
  let serial = 0;
  const tracker: MemoryDevTracker = {
    created,
    failing: false,
    set(task) {
      tasks.set(task.ref.toLowerCase(), task);
    },
    async createTask(input) {
      if (tracker.failing) throw new Error('таск-менеджер недоступен');
      created.push(input);
      const ref = `TASK-${++serial}`;
      const task: DevTrackerTask = { ref, url: `${baseUrl}/tasks/${ref}`, status: 'todo' };
      tasks.set(ref.toLowerCase(), task);
      return { ref: task.ref, url: task.url };
    },
    async getTask(ref) {
      if (tracker.failing) throw new Error('таск-менеджер недоступен');
      return tasks.get(ref.toLowerCase()) ?? null;
    },
  };
  return tracker;
}
