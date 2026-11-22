import 'server-only';
import { readSetting } from '@/modules/hdc/api';
import { namesOf, type StaffContext } from '@/modules/hdu/api';
import { returnToL1Tx, transferToL2Tx } from '../core/lines';
import { parseInput, returnInput, transferInput } from '../input';
import { PICKUP_SETTING } from '../pref';

// Передача между линиями на рабочем месте (план M3, задача 9). Сотрудник из проверенной сессии, вход по схеме,
// права и переходы проверяет слой core, записку и событие хранит база только для сотрудников.

/** Передать на вторую линию с запиской (FR-LINE-03): причина, что проверено, что требуется. */
export async function transferToL2(ctx: StaffContext, input: unknown): Promise<void> {
  const data = parseInput(transferInput, input);
  await transferToL2Tx(ctx.actor, data.number, { reason: data.reason, checked: data.checked, needed: data.needed, checklist: data.checklist }, await readSetting(PICKUP_SETTING));
}

/** Вернуть на первую линию с пояснением (FR-LINE-04). */
export async function returnToL1(ctx: StaffContext, input: unknown): Promise<void> {
  const data = parseInput(returnInput, input);
  await returnToL1Tx(ctx.actor, data.number, data.explanation, async (userId) => (await namesOf(ctx.actor, [userId])).get(userId) ?? null);
}
