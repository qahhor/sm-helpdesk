// Модуль hdw: интерфейс таск-менеджера разработки (ТЗ 11.11, FR-DEV-01). Две реализации: ручная (manual.ts) и для API
// таск-менеджера Smartup (smartup.ts); для тестов заглушка в памяти (memory.ts). Интерфейс повторяет ТЗ дословно.

export interface DevTracker {
  createTask(input: { title: string; descriptionMd: string; kind: 'bug' | 'feature'; priority?: string; moduleCode?: string; sourceUrl: string }): Promise<{ ref: string; url: string }>;
  getTask(ref: string): Promise<{ ref: string; url: string; version?: string; status: 'todo' | 'in_progress' | 'done' | 'cancelled' } | null>;
}

export type DevTrackerTask = NonNullable<Awaited<ReturnType<DevTracker['getTask']>>>;
export type DevTrackerTaskInput = Parameters<DevTracker['createTask']>[0];
