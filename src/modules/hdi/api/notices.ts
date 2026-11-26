import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { noticeSentRecentlyTx, notifyManyTx } from '@/modules/hdn/api/idea-notices';
import { staffIdsWithRole } from '@/modules/hdu/api/recipients';
import { pendingSinceTx } from '../core/staff';
import { MODERATION_DUE_WORKING_DAYS } from '../pref';
import { workingDaysBetween } from '../util';

// Модуль hdi, слой api: ежедневная сводка модерации (план M7, задача 8, решение 15). Задание ideas.moderation_digest
// в 09:30 по Ташкенту: если идеи ждут модерации дольше двух рабочих дней, каждый сотрудник с ролью product получает
// одно уведомление с их числом и письмо (если не выключил письма об идеях). Повторный запуск в тот же день ничего не
// шлёт. Узкий файл: его тянет фоновый процесс.

export async function runModerationDigest(system: SystemActor, now: Date): Promise<{ due: number; notified: number; skipped: boolean }> {
  const product = await staffIdsWithRole('product');
  return withActor(system, async (tx) => {
    if (await noticeSentRecentlyTx(tx, 'idea_moderation_due')) return { due: 0, notified: 0, skipped: true };
    const due = (await pendingSinceTx(tx)).filter((createdOn) => workingDaysBetween(createdOn, now) >= MODERATION_DUE_WORKING_DAYS).length;
    if (due === 0 || product.length === 0) return { due, notified: 0, skipped: false };
    const { bell } = await notifyManyTx(tx, {
      kind: 'idea_moderation_due',
      ideaId: null,
      userIds: product,
      payload: { count: due },
      mail: { payload: { template: 'staff_idea_moderation', count: due, url: '/agent/ideas' }, settingsPath: '/agent/account', always: false, dayKey: '' },
    });
    return { due, notified: bell, skipped: false };
  });
}
