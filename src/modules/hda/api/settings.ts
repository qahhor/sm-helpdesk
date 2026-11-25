import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext, writeSettingTx } from '@/modules/hdc/api';
import { HdaError } from '../error';
import { AI_DAILY_LIMIT_MAX, AI_DAILY_LIMIT_SETTING } from '../pref';
import { aiDailyLimit } from './run';

// Модуль hda, слой api: суточный предел вызовов модели (план M5, решение 13; поправка 101). Меняет администратор со
// входом не старше 15 минут, запись в журнал аудита той же транзакцией (writeSettingTx).

export { HdaError, isHdaError } from '../error';

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdaError('forbidden');
}

export async function aiDailyLimitSetting(ctx: StaffContext): Promise<number> {
  requireAdmin(ctx);
  return aiDailyLimit();
}

export async function saveAiDailyLimit(ctx: StaffContext, input: unknown): Promise<void> {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdaError('stale_session');
  const parsed = z.strictObject({ limit: z.coerce.number().int().min(0).max(AI_DAILY_LIMIT_MAX) }).safeParse(input);
  if (!parsed.success) throw new HdaError('invalid_input');
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, AI_DAILY_LIMIT_SETTING, parsed.data.limit));
}
