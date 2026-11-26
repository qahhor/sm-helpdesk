import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeSettingTx } from '@/modules/hdc/api';
import { HdiError } from '../error';
import { VOTE_MODE_DEFAULT, VOTE_MODE_SETTING, VOTE_MODES, type VoteMode } from '../pref';

// Модуль hdi, слой api: способ подсчёта голосов для доски и отбора (замечание к решению 5 ТЗ, решение 3 плана M7).
// Читают доска и задание отбора; меняет администратор со входом не старше 15 минут, запись в журнал аудита той же
// транзакцией (writeSettingTx). Нет строки или значение неверное: per_user.

const voteModeValue = z.enum(VOTE_MODES);

export async function voteMode(): Promise<VoteMode> {
  const parsed = voteModeValue.safeParse(await readSetting(VOTE_MODE_SETTING));
  return parsed.success ? parsed.data : VOTE_MODE_DEFAULT;
}

export async function saveVoteMode(ctx: StaffContext, input: unknown): Promise<void> {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdiError('forbidden');
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdiError('stale_session');
  const parsed = z.strictObject({ mode: voteModeValue }).safeParse(input);
  if (!parsed.success) throw new HdiError('invalid_input');
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, VOTE_MODE_SETTING, parsed.data.mode));
}
