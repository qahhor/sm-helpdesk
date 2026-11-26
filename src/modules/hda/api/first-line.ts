import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { type FirstLineResult, runFirstLine, runWatchdog } from '../first-line/run';

// Модуль hda, слой api: задания фонового процесса первой линии (план M5b, задача 4, решение 5). В задании только
// идентификатор обращения: остальное берётся из базы. Повторов pg-boss нет: сбой внутри ведёт к передаче сотруднику.

const ticketJob = z.strictObject({ ticketId: z.uuid() });
const watchdogJob = z.strictObject({ ticketId: z.uuid().optional() });

export async function runFirstLineJob(system: SystemActor, data: unknown): Promise<FirstLineResult> {
  if (system.type !== 'system') throw new Error('hda: задача только для системы');
  return runFirstLine(system, ticketJob.parse(data).ticketId);
}

/** Через 60 секунд после создания или ответа клиента (с ticketId) и раз в минуту по расписанию (без него). */
export async function runWatchdogJob(system: SystemActor, data: unknown): Promise<number> {
  if (system.type !== 'system') throw new Error('hda: задача только для системы');
  const { ticketId } = watchdogJob.parse(data ?? {});
  return runWatchdog(system, ticketId ? { ticketId } : {});
}
