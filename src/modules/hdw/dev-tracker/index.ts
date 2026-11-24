import 'server-only';
import { env } from '@/env';
import type { DevTrackerKind } from '../pref';
import { createManualTracker } from './manual';
import type { DevTracker } from './types';

// Модуль hdw: выбор таск-менеджера по окружению (FR-DEV-01; решение 13 плана M8). DEV_TRACKER=manual (по умолчанию):
// номер и ссылку задачи вводит сотрудник. Реализация для API таск-менеджера Smartup добавляется задачей 8 плана M8.

let override: { mode: DevTrackerKind; tracker: DevTracker } | null = null;
let manual: DevTracker | undefined;

/** Режим работы с таск-менеджером: от него зависит форма передачи в разработку и то, кто меняет статус задачи. */
export function devTrackerMode(): DevTrackerKind {
  return override?.mode ?? env.DEV_TRACKER;
}

export function getDevTracker(): DevTracker {
  if (override) return override.tracker;
  return (manual ??= createManualTracker());
}

/** Тесты подменяют таск-менеджер и режим (null возвращает настоящие). */
export function setDevTrackerForTests(value: { mode: DevTrackerKind; tracker: DevTracker } | null): void {
  override = value;
}

export type { DevTracker, DevTrackerTask, DevTrackerTaskInput } from './types';
