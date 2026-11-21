import 'server-only';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authSession } from '../auth-schema';
import { staff } from '../schema';

// Модуль hdu, слой core: сессии. Без библиотеки входа: этот файл попадает и в команду консоли.
// Таблица auth.session принадлежит библиотеке входа;
// удаление строки завершает сессию на следующем запросе (кеша сессии в куке нет).

const SYSTEM = { type: 'system', job: 'identity.sessions' } as const;

/** Завершает все сессии пользователя внутри транзакции действия. Возвращает число завершённых. */
export async function revokeUserSessions(tx: Tx, userId: string): Promise<number> {
  const removed = await tx.delete(authSession).where(eq(authSession.userId, userId)).returning({ id: authSession.id });
  return removed.length;
}

/** Завершает одну сессию по идентификатору строки. */
export async function revokeSessionById(sessionId: string): Promise<void> {
  await withIdentity(SYSTEM, (tx) => tx.delete(authSession).where(eq(authSession.id, sessionId)));
}

export type SessionRow = { id: string; userAgent: string | null; ipAddress: string | null; createdAt: Date; updatedAt: Date };

/** Неистёкшие сессии пользователя, недавние первыми. Токен не читается. */
export async function listUserSessions(userId: string): Promise<SessionRow[]> {
  return withIdentity(SYSTEM, (tx) =>
    tx
      .select({ id: authSession.id, userAgent: authSession.userAgent, ipAddress: authSession.ipAddress, createdAt: authSession.createdAt, updatedAt: authSession.updatedAt })
      .from(authSession)
      .where(and(eq(authSession.userId, userId), gt(authSession.expiresAt, sql`now()`)))
      .orderBy(desc(authSession.updatedAt), desc(authSession.createdAt)),
  );
}

/** Сотрудник действует от своего имени (запись в журнале), клиент от имени системы (журнал не пишется). */
async function sessionActor(userId: string, ip?: string | null) {
  const staffRow = (await withIdentity(SYSTEM, (tx) => tx.select({ role: staff.role }).from(staff).where(eq(staff.userId, userId)).limit(1)))[0];
  return staffRow && staffRow.role !== 'agent_bot' ? ({ type: 'staff', userId, staffRole: staffRow.role, ip } as const) : SYSTEM;
}

/**
 * Завершает сессию по паре "идентификатор и пользователь": чужую так не найти. Завершение сессии
 * сотрудником пишется в журнал аудита в той же транзакции. Возвращает, была ли такая сессия.
 */
export async function revokeOwnSession(userId: string, sessionId: string, ip?: string | null): Promise<boolean> {
  const actor = await sessionActor(userId, ip);
  return withIdentity(actor, async (tx) => {
    const removed = await tx
      .delete(authSession)
      .where(and(eq(authSession.id, sessionId), eq(authSession.userId, userId)))
      .returning({ id: authSession.id });
    if (removed.length === 0) return false;
    if (actor.type === 'staff') await writeAudit(tx, { action: 'session.revoked', objectType: 'session', objectId: sessionId });
    return true;
  });
}

/** Завершает все сессии пользователя, кроме текущей. Возвращает, сколько завершено. */
export async function revokeOtherOwnSessions(userId: string, currentId: string, ip?: string | null): Promise<number> {
  const actor = await sessionActor(userId, ip);
  return withIdentity(actor, async (tx) => {
    const removed = await tx
      .delete(authSession)
      .where(and(eq(authSession.userId, userId), ne(authSession.id, currentId)))
      .returning({ id: authSession.id });
    if (removed.length > 0 && actor.type === 'staff')
      await writeAudit(tx, { action: 'session.revoked', objectType: 'user', objectId: userId, diff: { others: removed.length } });
    return removed.length;
  });
}
