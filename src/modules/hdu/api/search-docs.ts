import 'server-only';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { foldText, type SearchDocument } from '@/modules/hdc/api';
import { authUser } from '../auth-schema';
import { memberships, organizations, staff } from '../schema';

// Модуль hdu, слой api: документы справочников для индекса поиска сотрудника (план W6, решение 1). Коллекции
// hub_orgs и hub_people видит только ключ сотрудника. Адреса почты и телефоны не попадают никуда: поиск по адресу
// остаётся в PostgreSQL (таблицы идентичности под hub_auth). Имена людей читаются через withIdentity под системным
// актором (разрешённое исключение CLAUDE.md: таблицы идентичности).

const micros = sql<string>`(extract(epoch from ${organizations.modifiedOn}) * 1000000)::bigint::text`;

export async function buildOrgDocs(system: SystemActor, orgIds: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(orgIds.map((id) => [id, []]));
  if (orgIds.length === 0) return out;
  const rows = await withActor(system, (tx) =>
    tx
      .select({ orgId: organizations.orgId, name: organizations.name, inn: organizations.inn, external: organizations.externalCompanyId, state: organizations.state, kind: organizations.kind, version: micros })
      .from(organizations)
      .where(inArray(organizations.orgId, [...orgIds])),
  );
  for (const row of rows)
    out.set(row.orgId, [
      {
        id: row.orgId,
        name: row.name,
        name_fold: foldText(row.name),
        ...(row.inn ? { inn: row.inn } : {}),
        ...(row.external ? { external_company_id: row.external } : {}),
        state: row.state,
        kind: row.kind,
        version: Number(row.version),
      },
    ]);
  return out;
}

export async function pageOrgIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const rows = await withActor(system, (tx) =>
    tx.select({ id: organizations.orgId }).from(organizations).where(after ? gt(organizations.orgId, after) : undefined).orderBy(asc(organizations.orgId)).limit(limit),
  );
  return rows.map((r) => r.id);
}

export async function buildPersonDocs(system: SystemActor, userIds: readonly string[]): Promise<Map<string, SearchDocument[]>> {
  const out = new Map<string, SearchDocument[]>(userIds.map((id) => [id, []]));
  const ids = userIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return out;
  const { users, members, staffRows } = await withIdentity(system, async (tx) => ({
    users: await tx
      .select({ id: authUser.id, name: authUser.name, version: sql<string>`(extract(epoch from ${authUser.updatedAt}) * 1000000)::bigint::text` })
      .from(authUser)
      .where(inArray(authUser.id, ids)),
    members: await tx
      .select({ userId: memberships.userId, orgId: memberships.orgId, version: sql<string>`(extract(epoch from ${memberships.modifiedOn}) * 1000000)::bigint::text` })
      .from(memberships)
      .where(and(inArray(memberships.userId, ids), eq(memberships.state, 'active'))),
    staffRows: await tx
      .select({ userId: staff.userId, state: staff.state, version: sql<string>`(extract(epoch from ${staff.modifiedOn}) * 1000000)::bigint::text` })
      .from(staff)
      .where(inArray(staff.userId, ids)),
  }));
  for (const user of users) {
    const own = members.filter((m) => m.userId === user.id);
    const st = staffRows.find((s) => s.userId === user.id);
    // Версия: самое позднее из имени, участия и учётной записи сотрудника.
    const version = Math.max(Number(user.version), ...own.map((m) => Number(m.version)), st ? Number(st.version) : 0);
    out.set(user.id, [
      {
        id: user.id,
        name: user.name,
        name_fold: foldText(user.name),
        is_staff: st?.state === 'active',
        ...(own.length > 0 ? { org_ids: own.map((m) => m.orgId) } : {}),
        version,
      },
    ]);
  }
  return out;
}

export async function pagePersonIds(system: SystemActor, after: string | null, limit: number): Promise<string[]> {
  const rows = await withIdentity(system, (tx) =>
    tx.select({ id: authUser.id }).from(authUser).where(after ? gt(authUser.id, after) : undefined).orderBy(asc(authUser.id)).limit(limit),
  );
  return rows.map((r) => r.id);
}
