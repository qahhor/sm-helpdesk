import 'server-only';
import { lt } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { authSession, authVerification } from '../auth-schema';

// Модуль hdu, слой core: очистка просроченных строк библиотеки входа (проверка main, Q8).
// Без библиотеки входа: файл попадает в команду консоли. Строки портала с хешами ссылок
// (hdu_email_tokens, hdu_link_codes, hdu_login_codes) здесь не удаляются: удалять строки
// идентичности роли hub_auth запрещено, их очистит ночная задача M2 (решение 0023).

const SYSTEM = { type: 'system', job: 'maintenance.cleanup' } as const;
const DAY_MS = 86400 * 1000;

/** Удаляет сессии и одноразовые значения входа, срок которых вышел больше суток назад. */
export async function cleanupAuthRows(now: Date = new Date()): Promise<{ sessions: number; verifications: number }> {
  const before = new Date(now.getTime() - DAY_MS);
  return withIdentity(SYSTEM, async (tx) => {
    const sessions = await tx.delete(authSession).where(lt(authSession.expiresAt, before)).returning({ id: authSession.id });
    const verifications = await tx.delete(authVerification).where(lt(authVerification.expiresAt, before)).returning({ id: authVerification.id });
    return { sessions: sessions.length, verifications: verifications.length };
  });
}
