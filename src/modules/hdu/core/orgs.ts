import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { authSession, authUser } from '../auth-schema';
import type { ClientRole } from '../pref';
import { memberships, organizations, staff } from '../schema';

// Модуль hdu, слой core: организации пользователя и активная организация сессии (ТЗ 11.1, FR-ID-05).
// Без библиотеки входа: колонки activeOrgId и lastOrgId принадлежат порталу, библиотека их только хранит.
// Членство читается на каждом запросе от актора system: актора клиента ещё нет, его строят отсюда.

const SYSTEM = { type: 'system', job: 'identity.actor' } as const;

export type MyOrganization = { orgId: string; name: string; role: ClientRole };

/** Что нужно для построения актора: сотрудник ли это и где он действующий участник. */
export type ClientAccess = { isStaff: boolean; orgs: MyOrganization[] };

/** Действующие членства в действующих организациях, по названию. Одна транзакция вместе с проверкой сотрудника. */
export async function loadClientAccess(userId: string): Promise<ClientAccess> {
  return withIdentity(SYSTEM, async (tx) => {
    const staffRow = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, userId)).limit(1);
    if (staffRow.length > 0) return { isStaff: true, orgs: [] };
    const orgs = await tx
      .select({ orgId: organizations.orgId, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.orgId, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(memberships.state, 'active'), eq(organizations.state, 'active')))
      .orderBy(asc(organizations.name), asc(organizations.orgId));
    return { isStaff: false, orgs };
  });
}

/**
 * Записывает активную организацию сессии. remember: она же становится организацией последнего входа
 * пользователя, с неё начнётся следующая сессия. Членство проверяет вызывающий слой.
 */
export async function setActiveOrganization(
  target: { sessionId: string; userId: string },
  orgId: string,
  opts: { remember: boolean },
): Promise<void> {
  await withIdentity(SYSTEM, async (tx) => {
    await tx
      .update(authSession)
      .set({ activeOrgId: orgId })
      .where(and(eq(authSession.id, target.sessionId), eq(authSession.userId, target.userId)));
    if (opts.remember) await tx.update(authUser).set({ lastOrgId: orgId }).where(eq(authUser.id, target.userId));
  });
}
