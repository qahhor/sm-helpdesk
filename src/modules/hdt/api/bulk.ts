import 'server-only';
import type { StaffContext } from '@/modules/hdu/api';
import { mergeTx } from '../core/merge';
import { isHdtError } from '../error';
import { bulkInput, mergeInput, parseInput } from '../input';
import { assignTicket } from './agent';
import { returnToL1, transferToL2 } from './lines';
import { wakeAutomation } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';

// Объединение дублей и массовые действия (FR-AG-07, FR-AG-20, UX-A-10; план M3, задача 11). Массовое действие
// идёт по каждому обращению своей транзакцией теми же функциями, что и одиночное: права, переходы, записка и
// журнал те же. Отказ по одному обращению не отменяет остальные.

/** Объединить дубль с основным (решение 4): возвращает номер конечного основного обращения. */
export async function mergeTicket(ctx: StaffContext, input: unknown): Promise<{ intoNumber: number }> {
  const data = parseInput(mergeInput, input);
  const intoNumber = await mergeTx(ctx.actor, data.number, data.intoNumber);
  await wakeOutbox();
  await wakeAutomation();
  return { intoNumber };
}

export type BulkResult = { done: number[]; refused: { number: number; code: string }[] };

/** Массовое действие: назначить, сменить линию (с запиской или пояснением), закрыть как дубль. Итог по каждому. */
export async function bulkAction(ctx: StaffContext, input: unknown): Promise<BulkResult> {
  const data = parseInput(bulkInput, input);
  const result: BulkResult = { done: [], refused: [] };
  for (const number of [...new Set(data.numbers)]) {
    try {
      if (data.action === 'assign') await assignTicket(ctx, { number, assigneeId: data.assigneeId });
      else if (data.action === 'duplicate') await mergeTx(ctx.actor, number, data.intoNumber);
      else if (data.to === 'l2') await transferToL2(ctx, { number, reason: data.reason, checked: data.checked, needed: data.needed });
      else await returnToL1(ctx, { number, explanation: data.explanation });
      result.done.push(number);
    } catch (error) {
      if (!isHdtError(error)) throw error;
      result.refused.push({ number, code: error.code });
    }
  }
  if (result.done.length > 0) {
    await wakeOutbox();
    await wakeAutomation();
  }
  return result;
}
