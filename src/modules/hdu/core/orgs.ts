import 'server-only';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { containsText } from '@/db/contains';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authSession, authUser } from '../auth-schema';
import type { ClientRole } from '../pref';
import { contactIdentities, invitations, memberships, organizations, servers, staff, userProfiles } from '../schema';
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
  /** Отметка согласия на AI-обработку (план M9, решение 10): дата ГГГГ-ММ-ДД и основание. Только сотрудникам. */
  aiConsentOn: string | null;
  aiConsentRef: string | null;
  state: 'active' | 'passive';
  /** Вид: client или служебная service (миграция 0035). */
  kind: 'client' | 'service';
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
  kind: organizations.kind,
  aiConsentOn: organizations.aiConsentOn,
  aiConsentRef: organizations.aiConsentRef,
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

export type OrgSettings = { category?: 'A' | 'B' | 'C' | 'D' | null };

/**
 * Категория клиента (FR-ADM-02) от имени care или admin под ролью hub_auth. Признак AI-обработки меняет только
 * setOrgAiProcessingTx: включение требует отметки согласия (план M9, решение 10). Другие колонки сотруднику не даёт
 * изменить триггер t_hdu_organizations_guard (миграция 0007). Ничего не изменилось: ни записи, ни журнала.
 */
export async function updateOrgSettings(actor: StaffActor, orgId: string, settings: OrgSettings): Promise<boolean> {
  return withIdentity(actor, async (tx) => {
    const current = (await tx.select({ category: organizations.category }).from(organizations).where(eq(organizations.orgId, orgId)).limit(1).for('update'))[0];
    if (!current) return false;
    if (settings.category === undefined || settings.category === current.category) return true;
    await tx.update(organizations).set({ category: settings.category }).where(eq(organizations.orgId, orgId));
    await writeAudit(tx, { action: 'org.updated', objectType: 'organization', objectId: orgId, orgId, diff: { category: { from: current.category, to: settings.category } } });
    return true;
  });
}

export type OrgAiProcessingInput = { orgId: string; enabled: true; consentOn: string; consentRef: string } | { orgId: string; enabled: false };

/**
 * AI-обработка организации (план M9, задача 2, решение 10) в транзакции вызывающего под ролью hub_auth. Включение
 * записывает отметку согласия и журнал org.ai_consent_recorded; повторная отметка по включённой организации тоже
 * записывается. Выключение пишет org.ai_disabled и прежнюю отметку не стирает; выключенную не трогает.
 * Нет организации: false.
 */
export async function setOrgAiProcessingTx(tx: Tx, actor: StaffActor, input: OrgAiProcessingInput): Promise<boolean> {
  void actor;
  const current = (
    await tx
      .select({ isAiEnabled: organizations.isAiEnabled, kind: organizations.kind })
      .from(organizations)
      .where(eq(organizations.orgId, input.orgId))
      .limit(1)
      .for('update')
  )[0];
  if (!current || current.kind !== 'client') return false;
  if (!input.enabled) {
    if (!current.isAiEnabled) return true;
    await tx.update(organizations).set({ isAiEnabled: false }).where(eq(organizations.orgId, input.orgId));
    await writeAudit(tx, { action: 'org.ai_disabled', objectType: 'organization', objectId: input.orgId, orgId: input.orgId });
    return true;
  }
  // База включает выключенную организацию только с отметкой, поставленной в том же UPDATE (миграция 0129): прежняя
  // отметка сначала снимается, тогда и та же дата с тем же основанием ставятся заново (проверка M9, M5).
  if (!current.isAiEnabled) await tx.update(organizations).set({ aiConsentOn: null, aiConsentRef: null }).where(eq(organizations.orgId, input.orgId));
  await tx
    .update(organizations)
    .set({ isAiEnabled: true, aiConsentOn: input.consentOn, aiConsentRef: input.consentRef })
    .where(eq(organizations.orgId, input.orgId));
  await writeAudit(tx, {
    action: 'org.ai_consent_recorded',
    objectType: 'organization',
    objectId: input.orgId,
    orgId: input.orgId,
    diff: { consentOn: input.consentOn, consentRef: input.consentRef, wasEnabled: current.isAiEnabled },
  });
  return true;
}

/** То же своей транзакцией от имени сотрудника. */
export async function setOrgAiProcessingOf(actor: StaffActor, input: OrgAiProcessingInput): Promise<boolean> {
  return withIdentity(actor, (tx) => setOrgAiProcessingTx(tx, actor, input));
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

/**
 * Слова для обезличивания текста агенту (веха M8b, решение 8): название и ИНН организаций, имена их участников и
 * сотрудников, а также имена людей вне участников (otherNames, находка I1 независимой проверки).
 */
export type AgentRedactionTerms = { orgs: Map<string, { orgTerms: string[]; memberNames: string[] }>; staffNames: string[]; otherNames: string[] };

/**
 * Что нужно обезличиванию ответа сервера MCP (план M8b, решение 8; находка I1): по организациям их название, ИНН и
 * имена участников в любом состоянии (и бывших), имена из приглашений организации и гостей этих приглашений, имена
 * каналов связи участников; по людям обращений (userIds: автор, авторы сообщений, наблюдатели, в том числе гость из
 * письма не из организации) их имена и имена каналов связи; имена сотрудников портала. Ничего из этого агенту не
 * уходит: по этим словам текст заменяется обозначениями. Только система.
 */
export async function agentRedactionTermsOf(actor: SystemActor, input: { orgIds: readonly string[]; userIds: readonly string[] }): Promise<AgentRedactionTerms> {
  const ids = [...new Set(input.orgIds)];
  const people = [...new Set(input.userIds)];
  const cap = MEMBER_NAMES_MAX * Math.max(1, ids.length);
  // Приглашения организаций: таблица идентичности под ролью hub_auth, отдельная транзакция до основной (не вложена).
  const invited =
    ids.length === 0
      ? []
      : await withIdentity(actor, (tx) =>
          tx.select({ orgId: invitations.orgId, name: invitations.name, guestUserId: invitations.guestUserId }).from(invitations).where(inArray(invitations.orgId, ids)).limit(cap),
        );
  const guestIds = [...new Set(invited.flatMap((row) => (row.guestUserId ? [row.guestUserId] : [])))];
  return withActor(actor, async (tx) => {
    const orgs = ids.length === 0 ? [] : await tx.select({ orgId: organizations.orgId, name: organizations.name, inn: organizations.inn }).from(organizations).where(inArray(organizations.orgId, ids));
    const members =
      ids.length === 0
        ? []
        : await tx
            .select({ orgId: memberships.orgId, userId: memberships.userId, name: userProfiles.name })
            .from(memberships)
            .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
            .where(inArray(memberships.orgId, ids))
            .limit(cap);
    // Гости приглашений: имя учётной записи гостя.
    const guests = guestIds.length === 0 ? [] : await tx.select({ userId: userProfiles.userId, name: userProfiles.name }).from(userProfiles).where(inArray(userProfiles.userId, guestIds));
    const guestName = new Map(guests.map((g) => [g.userId, g.name]));
    const others = people.length === 0 ? [] : await tx.select({ userId: userProfiles.userId, name: userProfiles.name, isStaff: userProfiles.isStaff }).from(userProfiles).where(inArray(userProfiles.userId, people));
    const channelUsers = [...new Set([...members.map((m) => m.userId), ...people])];
    const channels =
      channelUsers.length === 0
        ? []
        : await tx
            .select({ userId: contactIdentities.userId, name: contactIdentities.displayName })
            .from(contactIdentities)
            .where(inArray(contactIdentities.userId, channelUsers))
            .limit(cap);
    const staffRows = await tx.select({ name: userProfiles.name }).from(userProfiles).where(eq(userProfiles.isStaff, true)).limit(MEMBER_NAMES_MAX);

    const map = new Map<string, { orgTerms: string[]; memberNames: string[] }>();
    for (const org of orgs) map.set(org.orgId, { orgTerms: [org.name, ...(org.inn ? [org.inn] : [])], memberNames: [] });
    const memberOrg = new Map<string, string>();
    for (const member of members) {
      memberOrg.set(member.userId, member.orgId);
      if (member.name) map.get(member.orgId)?.memberNames.push(member.name);
    }
    for (const row of invited)
      for (const name of [row.name, row.guestUserId ? guestName.get(row.guestUserId) : null]) if (name && row.orgId) map.get(row.orgId)?.memberNames.push(name);
    const otherNames: string[] = [];
    const staffNames = staffRows.flatMap((row) => (row.name ? [row.name] : []));
    for (const person of others) if (person.name) (person.isStaff ? staffNames : otherNames).push(person.name);
    for (const channel of channels) {
      if (!channel.name) continue;
      const org = memberOrg.get(channel.userId);
      if (org) map.get(org)?.memberNames.push(channel.name);
      else otherNames.push(channel.name);
    }
    const unique = (names: string[]) => [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    for (const entry of map.values()) entry.memberNames = unique(entry.memberNames);
    return { orgs: map, staffNames: unique(staffNames), otherNames: unique(otherNames) };
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
