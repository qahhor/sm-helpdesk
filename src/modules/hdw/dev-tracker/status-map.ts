import type { DevTaskStatus } from '../pref';

// Модуль hdw: соответствие статусов таск-менеджера Smartup статусам задачи в портале (FR-DEV-04; план M8, задача 8).
//
// ВНИМАНИЕ: перечень статусов настоящего таск-менеджера не получен. Слева то, что предполагается
// (docs/integrations/dev-tracker.md). Незнакомый статус ничего не меняет: решает вызывающий, записав его в журнал.

const STATUS_MAP: Readonly<Record<string, DevTaskStatus>> = {
  todo: 'todo',
  open: 'todo',
  new: 'todo',
  backlog: 'todo',
  in_progress: 'in_progress',
  doing: 'in_progress',
  review: 'in_progress',
  testing: 'in_progress',
  done: 'done',
  closed: 'done',
  released: 'done',
  resolved: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  rejected: 'cancelled',
  wont_fix: 'cancelled',
};

/** Статус задачи в портале по статусу таск-менеджера: без учёта регистра, пробел и дефис как подчёркивание. Незнакомый: null. */
export function mapTrackerStatus(raw: unknown): DevTaskStatus | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.hasOwn(STATUS_MAP, key) ? (STATUS_MAP[key] as DevTaskStatus) : null;
}
