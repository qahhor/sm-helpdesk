import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withIdentity } from '@/db/with-identity';
import { getAuth } from '../auth/instance';
import type { RequestInfo } from '../api/request';
import { authSession } from '../auth-schema';
import type { TrustedSignInWay } from '../pref';

// Модуль hdu, слой core: сессии. Таблица auth.session принадлежит библиотеке входа;
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

/**
 * Выдаёт сессию пользователю, которого портал только что проверил сам одноразовой ссылкой
 * (приглашение, ссылка из бота). Вызывать только после такой проверки. Сотруднику сессию не выдаст:
 * это отклоняет перехватчик библиотеки входа.
 */
export async function createTrustedSession(userId: string, via: TrustedSignInWay, request: RequestInfo): Promise<void> {
  const auth = await getAuth();
  const result = await auth.api.signInTrusted({ body: { userId, via }, headers: request.headers, returnHeaders: true });
  request.setCookies(result.headers);
}
