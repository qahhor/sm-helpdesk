import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { staffIdsWithRole } from '@/modules/hdu/api/recipients';
import { notifyCycleTx, runCycleTx } from '../core/cycles';
import { cycleDue } from '../util';
import { voteMode } from './settings';

// Модуль hdi, слой api: задание ideas.cycle (ТЗ FR-IDEA-09; план M7, задача 9, решения 16, 17). Расписание 1-го числа
// в 09:00 по Ташкенту; "сейчас" задание получает параметром, поэтому тесты и команда hub ideas:cycle подменяют время.
// Снимок, закрытие прошлого отбора без выбора, уведомления роли product и голосовавшим ставятся одной транзакцией.
// Узкий файл: его тянут фоновый процесс и команда консоли, без страниц и Next.js.

export type IdeaCycleResult = { status: 'too_early' } | { status: 'exists'; cycle: string } | { status: 'created'; cycle: string; shortlist: number[]; lapsed: number };

export async function runIdeaCycle(system: SystemActor, now: Date): Promise<IdeaCycleResult> {
  const cycle = cycleDue(now);
  if (!cycle) return { status: 'too_early' };
  const [mode, product] = await Promise.all([voteMode(), staffIdsWithRole('product')]);
  return withActor(system, async (tx) => {
    const run = await runCycleTx(tx, cycle, mode);
    if (run.status === 'exists') return run;
    await notifyCycleTx(tx, run, product);
    return { status: 'created', cycle: run.cycle, shortlist: run.shortlist, lapsed: run.lapsed };
  });
}
