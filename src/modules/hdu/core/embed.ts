import 'server-only';
import { and, eq, isNotNull } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authAccount, authUser } from '../auth-schema';
import type { ClientRole, ContextPlatform } from '../pref';
import { contextTokenUses, memberships, organizations, servers, staff } from '../schema';
import { syntheticEmail } from '../util';

// Модуль hdu, слой core: данные сессии виджета (план M6, задача 2; решения 4, 5, 15 и 16). Таблицы идентичности,
// поэтому под ролью hub_auth (withIdentity) от имени системы: человек ещё не опознан, опознаёт его этот код.

const SYSTEM = { type: 'system', job: 'embed.session' } as const;
const UNIQUE_VIOLATION = '23505';

/**
 * Запоминает использованный токен контекста. false: токен с этим jti от этого сервера уже был (повтор). Строка живёт
 * до срока токена с допуском часов, потом её удаляет ночная очистка (cleanupAuthRows).
 */
export async function rememberContextToken(serverId: string, jti: string, expiresOn: Date): Promise<boolean> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx.insert(contextTokenUses).values({ serverId, jti, expiresOn }).onConflictDoNothing().returning({ jti: contextTokenUses.jti }),
  );
  return rows.length > 0;
}

const cleanName = (value: string): string => Array.from(value.trim()).slice(0, 200).join('') || 'Smartup';

/**
 * Учётная запись пользователя Smartup по паре "сервер и sub": та же, что находит вход OAuth (resolveSmartupUser,
 * решение 0013). Нет: новый пользователь со служебным адресом и способ входа с этой парой, как после первого входа OAuth.
 * Два одновременных первых обмена одного человека не создают двух пользователей: уникальность пары держит база
 * (account_provider_account_u1), проигравший берёт запись победителя.
 */
export async function findOrCreateSmartupUser(serverCode: string, sub: string, name: string): Promise<{ userId: string; isStaff: boolean }> {
  const find = () =>
    withIdentity(SYSTEM, async (tx) => {
      const rows = await tx
        .select({ userId: authAccount.userId, staffId: staff.userId })
        .from(authAccount)
        .leftJoin(staff, eq(staff.userId, authAccount.userId))
        .where(and(eq(authAccount.providerId, serverCode), eq(authAccount.accountId, sub)))
        .limit(1);
      return rows[0] ? { userId: rows[0].userId, isStaff: rows[0].staffId !== null } : null;
    });
  const existing = await find();
  if (existing) return existing;
  try {
    return await withIdentity(SYSTEM, async (tx) => {
      const now = new Date();
      const [user] = await tx
        .insert(authUser)
        .values({ name: cleanName(name), email: syntheticEmail(), emailVerified: false, createdAt: now, updatedAt: now })
        .returning({ id: authUser.id });
      if (!user) throw new Error('Пользователь не создан');
      await tx.insert(authAccount).values({ providerId: serverCode, accountId: sub, userId: user.id, createdAt: now, updatedAt: now });
      return { userId: user.id, isStaff: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    const winner = await find();
    if (!winner) throw error;
    return winner;
  }
}

/**
 * Роль действующего участника действующей организации, если организация принадлежит этому действующему серверу
 * с включённым виджетом и человек не сотрудник. Иначе null. Проверяется на каждом запросе виджета: отключение
 * действует сразу (решение 16).
 */
export async function embedMembership(userId: string, orgId: string, serverId: string): Promise<{ role: ClientRole; serverCode: string } | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const isStaff = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, userId)).limit(1);
    if (isStaff.length > 0) return null;
    const rows = await tx
      .select({ role: memberships.role, serverCode: servers.code })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.orgId, memberships.orgId))
      .innerJoin(servers, eq(servers.serverId, organizations.serverId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.orgId, orgId),
          eq(memberships.state, 'active'),
          eq(organizations.state, 'active'),
          eq(organizations.kind, 'client'),
          eq(organizations.serverId, serverId),
          eq(servers.state, 'active'),
          // Виджет у сервера выключен: живые токены виджета перестают действовать сразу (замечание M3 проверки M6).
          isNotNull(servers.contextKeyMode),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Новая сессия виджета в журнале аудита, как вход клиента (решение 15): сервер и платформа, без токена. */
export async function noteEmbedSession(input: { userId: string; orgId: string; serverCode: string; platform: ContextPlatform; ip: string | null }): Promise<void> {
  await withIdentity(SYSTEM, (tx) =>
    writeAudit(tx, {
      action: 'client.embed_session',
      objectType: 'user',
      objectId: input.userId,
      orgId: input.orgId,
      diff: { server: input.serverCode, platform: input.platform },
      ip: input.ip,
    }),
  );
}
