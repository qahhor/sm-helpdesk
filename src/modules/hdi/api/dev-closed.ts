import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { notifyManyTx } from '@/modules/hdn/api/idea-notices';
import { staffIdsWithRole } from '@/modules/hdu/api/recipients';
import type { ClosedDevTask } from '@/modules/hdw/api/idea-links';
import { titlesTx } from '../core/notices';
import { ideas } from '../schema';

// Модуль hdi, слой api: задача разработки идеи закрыта (план M7, задача 9, решения 15, 18). Статус идеи не меняется:
// "Выпущена" ставит сотрудник с версией и датой. Каждый сотрудник с ролью product получает колокольчик и письмо по
// каждой идее "В разработке" этой задачи, в транзакции смены статуса задачи. Обработчик подключает src/wiring.ts к
// модулю hdw (hdw не знает идей). Узкий файл: его тянут все точки входа, в том числе фоновый процесс.

export async function ideaDevTaskClosed(tx: Tx, ideaIds: readonly string[], task: ClosedDevTask): Promise<number> {
  const rows = await tx
    .select({ ideaId: ideas.ideaId, number: ideas.number })
    .from(ideas)
    .where(and(inArray(ideas.ideaId, [...ideaIds]), eq(ideas.status, 'in_development')))
    .orderBy(ideas.number);
  if (rows.length === 0) return 0;
  const product = await staffIdsWithRole('product');
  let count = 0;
  for (const row of rows) {
    const { title } = await titlesTx(tx, row.ideaId);
    const { bell } = await notifyManyTx(tx, {
      kind: 'idea_dev_task_closed',
      ideaId: row.ideaId,
      userIds: product,
      payload: { idea: row.number, ref: task.ref },
      // Закрытие задачи бывает раз на задачу: письмо уходит всегда, без правила "одно в сутки".
      mail: { payload: { template: 'staff_idea_dev_task_closed', ref: task.ref, number: row.number, title, url: `/agent/ideas/${row.number}` }, settingsPath: '/agent/account', always: true, dayKey: row.ideaId },
    });
    count += bell;
  }
  return count;
}
