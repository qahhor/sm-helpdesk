import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withIdentity } from '@/db/with-identity';
import { authSession } from '../auth-schema';

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
