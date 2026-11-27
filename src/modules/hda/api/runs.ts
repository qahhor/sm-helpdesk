import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { recordDecisionTx } from '../core/runs';
import { recordFoundTx } from '../core/triage';
import type { FoundRef } from '../schema';
import type { AiDecision, AiHandoffReason } from '../pref';

// Модуль hda, слой api: решение кода по вызову первой линии в строке журнала (план M5b, решение 13). Только система.

export async function recordDecision(
  system: SystemActor,
  runId: string,
  decision: { decision: AiDecision; handoffReason?: AiHandoffReason | null; solutionId?: string | null; confidence?: number | null },
): Promise<void> {
  if (system.type !== 'system') throw new Error('hda: решение записывает только система');
  await withActor(system, (tx) => recordDecisionTx(tx, runId, decision));
}

/** Найденные решения вызова первой линии (номер и оценка) для блока AI сотрудника (план M5b, задача 7). */
export async function recordFound(system: SystemActor, runId: string, found: FoundRef[]): Promise<void> {
  if (system.type !== 'system') throw new Error('hda: решение записывает только система');
  await withActor(system, (tx) => recordFoundTx(tx, runId, found));
}
