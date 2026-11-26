import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { reviewFieldsTx } from '../core/triage';
import { runTriage, type TriageRunResult } from '../first-line/triage';
import type { TriageField } from '../pref';

// Модуль hda, слой api: задания фонового процесса для разбора (план M5b, задача 7, решения 6, 18). В задании только
// идентификатор обращения.

const ticketJob = z.strictObject({ ticketId: z.uuid() });

/** ai.triage: разбор без ответа помощника (решение 6). */
export async function runTriageJob(system: SystemActor, data: unknown): Promise<TriageRunResult> {
  if (system.type !== 'system') throw new Error('hda: задача только для системы');
  return runTriage(system, ticketJob.parse(data).ticketId);
}

/** ai.triage_review: ночью доля принятых по полю за месяц; ниже 70% при 30 решениях поле отключается (FR-TRI-04). */
export async function runTriageReview(system: SystemActor, opts: { now?: Date } = {}): Promise<TriageField[]> {
  if (system.type !== 'system') throw new Error('hda: задача только для системы');
  return withActor(system, (tx) => reviewFieldsTx(tx, opts.now ?? new Date()));
}
