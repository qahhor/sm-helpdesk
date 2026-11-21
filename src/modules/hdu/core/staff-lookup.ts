import 'server-only';
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { authUser } from '../auth-schema';
import { organizations, servers, staff } from '../schema';
import { isSyntheticEmail } from '../util';

// Модуль hdu, слой core: поиск организаций и людей для рабочего места (FR-AG-10; план M3, задача 5).
// Организации читаются под актором сотрудника. Имена и адреса лежат в таблицах идентичности: их читает
// withIdentity под ролью hub_auth (разрешённое исключение CLAUDE.md), и только для сотрудника.

const LOOKUP_LIMIT = 200;
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Организации по названию или ИНН. */
export async function findOrgIdsTx(actor: StaffActor, query: string): Promise<string[]> {
  const pattern = `%${likeEscape(query)}%`;
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ orgId: organizations.orgId })
      .from(organizations)
      .where(or(ilike(organizations.name, pattern), ilike(organizations.inn, pattern)))
      .limit(LOOKUP_LIMIT),
  );
  return rows.map((row) => row.orgId);
}

/** Люди по имени или подтверждённому адресу. Служебные адреса без почты не ищутся. */
export async function findUserIdsTx(actor: StaffActor, query: string): Promise<string[]> {
  const pattern = `%${likeEscape(query)}%`;
  const rows = await withIdentity(actor, (tx) =>
    tx
      .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified, name: authUser.name })
      .from(authUser)
      .where(or(ilike(authUser.name, pattern), and(eq(authUser.emailVerified, true), ilike(authUser.email, pattern))))
      .limit(LOOKUP_LIMIT),
  );
  return rows
    .filter((row) => row.name.toLowerCase().includes(query.toLowerCase()) || (row.emailVerified && !isSyntheticEmail(row.email)))
    .map((row) => row.id);
}

export type OrgSummary = { orgId: string; name: string; inn: string | null; category: 'A' | 'B' | 'C' | 'D' | null; serverName: string };

/** Названия, ИНН, категория и сервер организаций для списков и карточки обращения. */
export async function orgSummariesTx(actor: StaffActor, orgIds: string[]): Promise<Map<string, OrgSummary>> {
  if (orgIds.length === 0) return new Map();
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ orgId: organizations.orgId, name: organizations.name, inn: organizations.inn, category: organizations.category, serverName: servers.name })
      .from(organizations)
      .innerJoin(servers, eq(servers.serverId, organizations.serverId))
      .where(inArray(organizations.orgId, [...new Set(orgIds)])),
  );
  return new Map(rows.map((row) => [row.orgId, row]));
}

export type AssignableStaff = { userId: string; name: string; role: 'agent_l1' | 'agent_l2' | 'care' | 'admin' };

/**
 * Сотрудники, на которых можно назначить обращение: действующие, кроме роли product (ТЗ 5.2). Таблицу сотрудников
 * читает только hub_auth, поэтому список берёт система, а показывается он любому сотруднику.
 */
export async function assignableStaffTx(): Promise<AssignableStaff[]> {
  const rows = await withIdentity({ type: 'system', job: 'identity.staff-directory' }, (tx) =>
    tx
      .select({ userId: staff.userId, name: authUser.name, role: staff.role })
      .from(staff)
      .innerJoin(authUser, eq(authUser.id, staff.userId))
      .where(and(eq(staff.state, 'active'), inArray(staff.role, ['agent_l1', 'agent_l2', 'care', 'admin'])))
      .orderBy(asc(authUser.name)),
  );
  return rows as AssignableStaff[];
}
