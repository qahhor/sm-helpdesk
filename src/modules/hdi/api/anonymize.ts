import 'server-only';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdu/api';
import { HdiError } from '../error';
import { ideas } from '../schema';

// Модуль hdi, слой api: имя автора идей обезличенной учётной записи (ТЗ 14.6; волна 7, T2; решение 0162). Идея хранит
// имя автора снимком при подаче (решение 7 плана M7): после обезличивания учётной записи снимок заменяется тем же
// обезличенным именем. Вызывает администратор портала сразу после обезличивания; запись делает система (счётчики и
// снимки идей сотрудник не меняет). Снимок имени в комментариях база менять не даёт никому (триггер миграции 0079):
// он остаётся, это записано в решении 0162.

const SYSTEM: SystemActor = { type: 'system', job: 'identity.anonymize' };
const input = z.strictObject({ userId: z.uuid(), name: z.string().regex(/^#[0-9a-f]{8}$/) });

export async function anonymizeIdeaAuthor(ctx: StaffContext, raw: unknown): Promise<{ ideas: number }> {
  if (ctx?.actor?.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdiError('forbidden');
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new HdiError('invalid_input');
  const rows = await withActor(SYSTEM, (tx) => tx.update(ideas).set({ authorName: parsed.data.name }).where(eq(ideas.authorId, parsed.data.userId)).returning({ ideaId: ideas.ideaId }));
  return { ideas: rows.length };
}
