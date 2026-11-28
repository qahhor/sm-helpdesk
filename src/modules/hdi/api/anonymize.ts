import 'server-only';
import { and, eq, ne } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import type { StaffContext } from '@/modules/hdu/api';
import { anonymizedAccountName } from '@/modules/hdu/api/accounts';
import { HdiError } from '../error';
import { ideas } from '../schema';

// Модуль hdi, слой api: имя автора идей обезличенной учётной записи (ТЗ 14.6; волна 7, T2; решение 0162). Идея хранит
// имя автора снимком при подаче (решение 7 плана M7): после обезличивания учётной записи снимок заменяется тем же
// обезличенным именем. Вызывает администратор портала сразу после обезличивания; запись делает система (счётчики и
// снимки идей сотрудник не меняет). Снимок имени в комментариях база менять не даёт никому (триггер миграции 0079):
// он остаётся, это записано в решении 0162.
//
// Снимок меняется только у обезличенной учётной записи и только на её нынешнее имя (проверка W7, R11): иначе
// администратор мог бы подписать идеи действующего клиента чужим значком. Замена и запись user.ideas_anonymized
// идут одной транзакцией; повтор, которому менять нечего, записи не делает.

const SYSTEM: SystemActor = { type: 'system', job: 'identity.anonymize' };
const input = z.strictObject({ userId: z.uuid(), name: z.string().regex(/^#[0-9a-f]{8}$/) });

export async function anonymizeIdeaAuthor(ctx: StaffContext, raw: unknown): Promise<{ ideas: number }> {
  if (ctx?.actor?.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdiError('forbidden');
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new HdiError('invalid_input');
  const { userId, name } = parsed.data;
  if ((await anonymizedAccountName(userId)) !== name) throw new HdiError('invalid_input');
  const rows = await withActor(SYSTEM, async (tx) => {
    const changed = await tx
      .update(ideas)
      .set({ authorName: name })
      .where(and(eq(ideas.authorId, userId), ne(ideas.authorName, name)))
      .returning({ ideaId: ideas.ideaId });
    if (changed.length > 0) await writeAudit(tx, { action: 'user.ideas_anonymized', objectType: 'user', objectId: userId, diff: { ideas: changed.length } });
    return changed;
  });
  return { ideas: rows.length };
}
