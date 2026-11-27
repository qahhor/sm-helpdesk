import 'server-only';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { containsText } from '@/db/contains';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authSession, authUser } from '../auth-schema';
import type { ClientRole } from '../pref';
import { memberships, organizations, servers, staff, userProfiles } from '../schema';
import { signInMemberships } from './access';
import { directoryOrgIds } from './directory-search';

// Модуль hdu, слой core: организации пользователя и активная организация сессии (ТЗ 11.1, FR-ID-05).
// Без библиотеки входа: колонки activeOrgId и lastOrgId принадлежат порталу, библиотека их только хранит.
// Членство читается на каждом запросе от актора system: актора клиента ещё нет, его строят отсюда.

const SYSTEM = { type: 'system', job: 'identity.actor' } as const;

export type MyOrganization = { orgId: string; name: string; role: ClientRole };

/** Что нужно для построения актора: сотрудник ли это и где он действующий участник. */
export type ClientAccess = { isStaff: boolean; orgs: MyOrganization[] };

/**
 * Действующие членства в действующих организациях, по названию. Одна транзакция вместе с проверкой сотрудника.
 * Гостевое членство (source = 'guest', появится в M4 с приёмом почты) входа не даёт и здесь не учитывается.
 */
export async function loadClientAccess(userId: string): Promise<ClientAccess> {
  return withIdentity(SYSTEM, async (tx) => {
    const staffRow = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, userId)).limit(1);
    if (staffRow.length > 0) return { isStaff: true, orgs: [] };
    const rows = await signInMemberships(tx, eq(memberships.userId, userId)).orderBy(asc(organizations.name), asc(organizations.orgId));
    return { isStaff: false, orgs: rows.map(({ orgId, name, role }) => ({ orgId, name, role })) };
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
  /** Обращения организации обрабатывает AI-помощник (FR-ADM-02). */
  isAiEnabled: boolean;
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
  isAiEnabled: organizations.isAiEnabled,
  state: organizations.state,
  memberCount: sql<number>`(select count(*)::int from hdu_memberships m where m.org_id = ${organizations.orgId} and m.state = 'active')`,
};

/** Знаки шаблона LIKE в запросе ищутся как обычные знаки. */

/** Поиск по названию, ИНН и идентификатору компании, без учёта регистра. limit + 1 строка: есть ли ещё. */
export async function searchOrgs(actor: StaffActor, input: { query: string; offset: number; limit: number }): Promise<OrgRow[]> {
  // Текст ищет Typesense (план W6, задача 5): до 250 лучших, порядок списка прежний (по названию). Не ответил или
  // совпадений больше 250 (лучшие 250 не дают листать дальше, M6 независимой проверки): прежний ILIKE.
  const directory = input.query ? await directoryOrgIds(actor, input.query) : null;
  const found = directory && !directory.truncated ? directory.ids : null;
  const filter = found
    ? inArray(organizations.orgId, found)
    : input.query
      ? or(containsText(organizations.name, input.query), containsText(organizations.inn, input.query), containsText(organizations.externalCompanyId, input.query))
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

export type OrgSettings = { category?: 'A' | 'B' | 'C' | 'D' | null; isAiEnabled?: boolean };

/**
 * Категория клиента и признак AI-обработки (FR-ADM-02) от имени care или admin под ролью hub_auth.
 * Другие колонки сотруднику не даёт изменить триггер t_hdu_organizations_guard (миграция 0007).
 * В журнал org.updated идут прежние и новые значения изменённых полей. Ничего не изменилось: ни записи, ни журнала.
 */
export async function updateOrgSettings(actor: StaffActor, orgId: string, settings: OrgSettings): Promise<boolean> {
  return withIdentity(actor, async (tx) => {
    const current = (
      await tx
        .select({ category: organizations.category, isAiEnabled: organizations.isAiEnabled })
        .from(organizations)
        .where(eq(organizations.orgId, orgId))
        .limit(1)
        .for('update')
    )[0];
    if (!current) return false;
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    if (settings.category !== undefined && settings.category !== current.category) diff.category = { from: current.category, to: settings.category };
    if (settings.isAiEnabled !== undefined && settings.isAiEnabled !== current.isAiEnabled)
      diff.isAiEnabled = { from: current.isAiEnabled, to: settings.isAiEnabled };
    if (Object.keys(diff).length === 0) return true;
    await tx
      .update(organizations)
      .set({
        ...(diff.category && { category: settings.category }),
        ...(diff.isAiEnabled && { isAiEnabled: settings.isAiEnabled }),
      })
      .where(eq(organizations.orgId, orgId));
    await writeAudit(tx, { action: 'org.updated', objectType: 'organization', objectId: orgId, orgId, diff });
    return true;
  });
}

/** memberNames: имена всех участников организации, и тех, кто в переписке не писал (0057, I3s). */
export type OrgAiProfile = { name: string; inn: string | null; isAiEnabled: boolean; people: { userId: string; name: string; isStaff: boolean }[]; memberNames: string[] };

/** Сколько имён участников организации берётся для вырезания: у организации их обычно десятки. */
const MEMBER_NAMES_MAX = 2000;

/**
 * Что нужно отбору данных для модели (ТЗ 14.3; план M5, задача 5): включена ли AI-обработка организации, её название
 * и ИНН, имена участников переписки. Название, ИНН и имена в модель не уходят: по ним они вырезаются из текста.
 */
export async function orgAiProfileOf(actor: SystemActor | StaffActor, orgId: string, userIds: readonly string[]): Promise<OrgAiProfile | null> {
  return withActor(actor, async (tx) => {
    const [org] = await tx
      .select({ name: organizations.name, inn: organizations.inn, isAiEnabled: organizations.isAiEnabled })
      .from(organizations)
      .where(eq(organizations.orgId, orgId))
      .limit(1);
    if (!org) return null;
    const ids = [...new Set(userIds)];
    const people = ids.length === 0 ? [] : await tx.select({ userId: userProfiles.userId, name: userProfiles.name, isStaff: userProfiles.isStaff }).from(userProfiles).where(inArray(userProfiles.userId, ids));
    // Участники организации в любом состоянии: имя бывшего сотрудника клиента тоже его данные.
    const members = await tx
      .select({ name: userProfiles.name })
      .from(memberships)
      .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .limit(MEMBER_NAMES_MAX);
    return { ...org, people, memberNames: members.map((m) => m.name).filter((name): name is string => Boolean(name)) };
  });
}

/** Слова для обезличивания текста агенту (веха M8b, решение 8): название и ИНН организаций, имена их участников и сотрудников. */
export type AgentRedactionTerms = { orgs: Map<string, { orgTerms: string[]; memberNames: string[] }>; staffNames: string[] };

/**
 * Что нужно обезличиванию ответа сервера MCP (план M8b, решение 8): по организациям обращений их название, ИНН и имена
 * участников, а также имена сотрудников портала. Ничего из этого агенту не уходит: по этим словам текст заменяется
 * обозначениями. Только система.
 */
export async function agentRedactionTermsOf(actor: SystemActor, orgIds: readonly string[]): Promise<AgentRedactionTerms> {
  const ids = [...new Set(orgIds)];
  return withActor(actor, async (tx) => {
    const orgs = ids.length === 0 ? [] : await tx.select({ orgId: organizations.orgId, name: organizations.name, inn: organizations.inn }).from(organizations).where(inArray(organizations.orgId, ids));
    const members =
      ids.length === 0
        ? []
        : await tx
            .select({ orgId: memberships.orgId, name: userProfiles.name })
            .from(memberships)
            .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
            .where(inArray(memberships.orgId, ids))
            .limit(MEMBER_NAMES_MAX * Math.max(1, ids.length));
    const staffRows = await tx.select({ name: userProfiles.name }).from(userProfiles).where(eq(userProfiles.isStaff, true)).limit(MEMBER_NAMES_MAX);
    const map = new Map<string, { orgTerms: string[]; memberNames: string[] }>();
    for (const org of orgs) map.set(org.orgId, { orgTerms: [org.name, ...(org.inn ? [org.inn] : [])], memberNames: [] });
    for (const member of members) if (member.name) map.get(member.orgId)?.memberNames.push(member.name);
    return { orgs: map, staffNames: staffRows.flatMap((row) => (row.name ? [row.name] : [])) };
  });
}

export type OrgFacts = { orgId: string; name: string; inn: string | null; category: 'A' | 'B' | 'C' | 'D' | null; serverId: string | null };

/** Название, ИНН, категория и сервер организаций: сведения известной проблемы и проверка её публичного текста (план M5c). */
export async function orgFactsOf(actor: SystemActor | StaffActor, orgIds: readonly string[]): Promise<OrgFacts[]> {
  const ids = [...new Set(orgIds)];
  if (ids.length === 0) return [];
  return withActor(actor, (tx) =>
    tx
      .select({ orgId: organizations.orgId, name: organizations.name, inn: organizations.inn, category: organizations.category, serverId: organizations.serverId })
      .from(organizations)
      .where(inArray(organizations.orgId, ids)),
  );
}
