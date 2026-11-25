import 'server-only';
import { lt, sql } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { authSession, authVerification } from '../auth-schema';
import { contextTokenUses, emailTokens, linkCodes, loginCodes } from '../schema';

// Модуль hdu, слой core: очистка просроченных строк входа (проверка main, Q8; решение 0023 с дополнением M2).
// Без библиотеки входа: файл попадает в команду консоли и в фоновый процесс. Строки портала с хешами ссылок
// (hdu_email_tokens, hdu_link_codes, hdu_login_codes) удаляются по узкому праву миграции 0015: только системой
// и только когда срок вышел больше суток назад.

const SYSTEM = { type: 'system', job: 'maintenance.cleanup' } as const;
const DAY_MS = 86400 * 1000;

/** Удаляет сессии, одноразовые значения входа, ссылки и коды, срок которых вышел больше суток назад, и использованные токены контекста. */
export async function cleanupAuthRows(now: Date = new Date()): Promise<{ sessions: number; verifications: number; links: number }> {
  const before = new Date(now.getTime() - DAY_MS);
  return withIdentity(SYSTEM, async (tx) => {
    const sessions = await tx.delete(authSession).where(lt(authSession.expiresAt, before)).returning({ id: authSession.id });
    const verifications = await tx.delete(authVerification).where(lt(authVerification.expiresAt, before)).returning({ id: authVerification.id });
    const tokens = await tx.delete(emailTokens).where(lt(emailTokens.expiresOn, before)).returning({ id: emailTokens.tokenId });
    const links = await tx.delete(linkCodes).where(lt(linkCodes.expiresOn, before)).returning({ id: linkCodes.linkCodeId });
    const logins = await tx.delete(loginCodes).where(lt(loginCodes.expiresOn, before)).returning({ id: loginCodes.loginCodeId });
    // Использованные токены контекста виджета (план M6, решение 4): срок строки уже включает допуск часов, она не нужна
    // сразу после него. Удалить действующую строку политика не даёт (миграция 0078).
    const contextTokens = await tx.delete(contextTokenUses).where(lt(contextTokenUses.expiresOn, sql`now()`)).returning({ jti: contextTokenUses.jti });
    return { sessions: sessions.length, verifications: verifications.length, links: tokens.length + links.length + logins.length + contextTokens.length };
  });
}
