import 'server-only';
import { eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authSession, authUser } from '../auth-schema';
import { HduError } from '../error';
import { parseInput } from '../input';
import { staff } from '../schema';

// Модуль hdu, слой api: завершение сессий для инцидента (план M9, задача 4, решение 9; ASVS V7.4.5). Вызывает только
// команда консоли hub sessions:revoke на сервере (актор system); кнопки в интерфейсе нет. Охват: один пользователь по
// адресу, все сотрудники или все. Удаление строк и запись session.revoked_bulk одной транзакцией; в журнале охват,
// число и идентификатор пользователя, без адресов.

export type RevokeScope = { scope: 'user'; email: string } | { scope: 'staff' } | { scope: 'all' };

const revokeInput = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('user'), email: z.email().trim().toLowerCase().max(320) }),
  z.strictObject({ scope: z.literal('staff') }),
  z.strictObject({ scope: z.literal('all') }),
]);

export async function revokeSessions(actor: SystemActor, input: unknown): Promise<{ revoked: number }> {
  if (actor?.type !== 'system') throw new HduError('forbidden');
  const data = parseInput(revokeInput, input);
  return withIdentity(actor, async (tx) => {
    let revoked: number;
    let userId: string | undefined;
    if (data.scope === 'user') {
      const user = (await tx.select({ id: authUser.id }).from(authUser).where(sql`lower(${authUser.email}) = ${data.email}`).limit(1))[0];
      if (!user) throw new HduError('not_found');
      userId = user.id;
      revoked = (await tx.delete(authSession).where(eq(authSession.userId, user.id)).returning({ id: authSession.id })).length;
    } else if (data.scope === 'staff') {
      revoked = (await tx.delete(authSession).where(inArray(authSession.userId, tx.select({ id: staff.userId }).from(staff))).returning({ id: authSession.id })).length;
    } else {
      revoked = (await tx.delete(authSession).returning({ id: authSession.id })).length;
    }
    await writeAudit(tx, {
      action: 'session.revoked_bulk',
      objectType: userId ? 'user' : 'session',
      ...(userId ? { objectId: userId } : {}),
      diff: { scope: data.scope, revoked },
    });
    return { revoked };
  });
}
