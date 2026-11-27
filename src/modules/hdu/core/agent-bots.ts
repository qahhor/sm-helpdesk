import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authUser } from '../auth-schema';
import { staff } from '../schema';
import { syntheticEmail } from '../util';

// Модуль hdu, слой core: учётные записи AI-сотрудников (веха M8b, задача 3; ТЗ 5.2 роль agent_bot, 10.5
// agent_tokens.staff_user_id; план M8b, решение 16). Под ролью hub_auth от актора system: сотрудников заводит только
// он (политика hdu_staff_system_all). Учётная запись без пароля, второго фактора и способа входа: вход роли agent_bot
// закрыт и проверками входа (auth/hooks.ts, api/session.ts). Имя "AI-сотрудник: <имя токена>", одна на имя.

const SYSTEM = { type: 'system', job: 'identity.agent_bot' } as const;
export const AGENT_BOT_PREFIX = 'AI-сотрудник: ';

/** Учётная запись agent_bot для имени токена: существующая или новая. Два одновременных выпуска не создают двух. */
export async function ensureAgentBotTx(tokenName: string): Promise<{ userId: string; created: boolean }> {
  const name = `${AGENT_BOT_PREFIX}${tokenName}`;
  return withIdentity(SYSTEM, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-bot:${name}`}))`);
    const existing = await tx
      .select({ userId: authUser.id })
      .from(authUser)
      .innerJoin(staff, and(eq(staff.userId, authUser.id), eq(staff.role, 'agent_bot')))
      .where(eq(authUser.name, name))
      .limit(1);
    if (existing[0]) return { userId: existing[0].userId, created: false };
    const [user] = await tx.insert(authUser).values({ name, email: syntheticEmail(), emailVerified: false }).returning({ id: authUser.id });
    if (!user) throw new Error('учётная запись AI-сотрудника не создана');
    await tx.insert(staff).values({ userId: user.id, role: 'agent_bot' });
    await writeAudit(tx, { action: 'staff.created', objectType: 'staff', objectId: user.id, diff: { role: 'agent_bot' } });
    return { userId: user.id, created: true };
  });
}
