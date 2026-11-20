import 'server-only';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { authSession, authUser } from '../auth-schema';
import type { ClientRole } from '../pref';
import { memberships, organizations, servers, staff } from '../schema';

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

// --- Организации в рабочем месте (задача 12). Чтение через hub_app от имени сотрудника ---

export type OrgRow = {
  orgId: string;
  name: string;
  inn: string | null;
  serverName: string;
  category: 'A' | 'B' | 'C' | 'D' | null;
  state: 'active' | 'passive';
  /** Действующих участников. */
  memberCount: number;
};

const orgColumns = {
  orgId: organizations.orgId,
  name: organizations.name,
  inn: organizations.inn,
  serverName: servers.name,
  category: organizations.category,
  state: organizations.state,
  memberCount: sql<number>`(select count(*)::int from hdu_memberships m where m.org_id = ${organizations.orgId} and m.state = 'active')`,
};

/** Знаки шаблона LIKE в запросе ищутся как обычные знаки. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Поиск по названию, ИНН и идентификатору компании, без учёта регистра. limit + 1 строка: есть ли ещё. */
export async function searchOrgs(actor: StaffActor, input: { query: string; offset: number; limit: number }): Promise<OrgRow[]> {
  const pattern = `%${likeEscape(input.query)}%`;
  const filter = input.query
    ? or(ilike(organizations.name, pattern), ilike(organizations.inn, pattern), ilike(organizations.externalCompanyId, pattern))
    : undefined;
  return withActor(actor, (tx) =>
    tx
      .select(orgColumns)
      .from(organizations)
      .innerJoin(servers, eq(servers.serverId, organizations.serverId))
      .where(filter)
      .orderBy(asc(organizations.name), asc(organizations.orgId))
      .limit(input.limit + 1)
      .offset(input.offset),
  );
}

/** Одна организация глазами сотрудника. */
export async function getOrgRow(actor: StaffActor, orgId: string): Promise<OrgRow | null> {
  const rows = await withActor(actor, (tx) =>
    tx.select(orgColumns).from(organizations).innerJoin(servers, eq(servers.serverId, organizations.serverId)).where(eq(organizations.orgId, orgId)).limit(1),
  );
  return rows[0] ?? null;
}
