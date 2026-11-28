import 'server-only';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type Actor, type ClientActor, type StaffActor, withActor } from '@/db/with-actor';
import { containsText } from '@/db/contains';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authUser } from '../auth-schema';
import { HduError } from '../error';
import type { ClientRole, MembershipSource, RecordState } from '../pref';
import { isSyntheticEmail } from '../util';
import { memberships, organizations, userProfiles } from '../schema';

// Модуль hdu, слой core: участники организации. Чтение через hub_app и политики чтения,
// изменение через hub_auth от имени актора: политики базы страхуют проверку прав в слое api.

export type MemberRow = { userId: string; name: string; role: ClientRole; source: MembershipSource; state: RecordState };

/** Ключ листания: порядок списка (состояние, имя, идентификатор). */
export type MemberKey = { state: RecordState; name: string; userId: string };

const memberColumns = {
  userId: memberships.userId,
  name: userProfiles.name,
  role: memberships.role,
  source: memberships.source,
  state: memberships.state,
};

/**
 * Участники организации с именами, страницей по ключу (проверка качества, Q20): действующие раньше отключённых, по
 * имени, затем по идентификатору. Возвращает на одну строку больше limit, если дальше есть ещё. Адресов и других полей
 * учётной записи здесь нет.
 */
export async function pageOrgMembers(
  actor: ClientActor | StaffActor,
  orgId: string,
  opts: { q: string | null; after: MemberKey | null; limit: number; state?: RecordState },
): Promise<MemberRow[]> {
  const { q, after, limit } = opts;
  return withActor(actor, (tx) =>
    tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
      .where(
        and(
          eq(memberships.orgId, orgId),
          opts.state ? eq(memberships.state, opts.state) : undefined,
          // Знаки шаблона в поиске ищутся как текст: шаблон собирает общий помощник (решение 0041).
          q ? containsText(userProfiles.name, q) : undefined,
          after ? sql`(${memberships.state}, ${userProfiles.name}, ${memberships.userId}) > (${after.state}, ${after.name}, ${after.userId}::uuid)` : undefined,
        ),
      )
      .orderBy(asc(memberships.state), asc(userProfiles.name), asc(memberships.userId))
      .limit(limit + 1),
  );
}

/** Один участник организации или null: чужого для актора и для этой организации нет. */
export async function findOrgMember(actor: ClientActor | StaffActor, orgId: string, userId: string): Promise<MemberRow | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Название действующей организации глазами актора. Пусто, если её нет или она отключена. */
export async function findActiveOrgName(actor: ClientActor | StaffActor, orgId: string): Promise<string | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.orgId, orgId), eq(organizations.state, 'active')))
      .limit(1),
  );
  return rows[0]?.name ?? null;
}

/**
 * Состояние участника (пункт 12 таблицы решений M1). Одна транзакция с записью в журнале аудита.
 * Тот же статус ничего не меняет и в журнал не пишется. Строки, которую актор не видит, для него нет.
 */
export async function changeMemberState(actor: ClientActor | StaffActor, orgId: string, userId: string, state: RecordState): Promise<void> {
  await withIdentity(actor, async (tx) => {
    const current = (
      await tx
        .select({ state: memberships.state })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1)
        .for('update')
    )[0];
    if (!current) throw new HduError('not_found');
    if (current.state === state) return;
    await tx
      .update(memberships)
      .set({ state })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    await writeAudit(tx, {
      action: 'member.state_changed',
      objectType: 'membership',
      objectId: userId,
      orgId,
      diff: { from: current.state, to: state },
    });
  });
}

/**
 * Подтверждённые адреса пользователей для карточки организации в рабочем месте. Служебный адрес
 * не адрес человека и не показывается. Таблица учётных записей доступна только hub_auth: читает система.
 */
export async function findVerifiedEmails(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await withIdentity({ type: 'system', job: 'identity.staff-view' }, (tx) =>
    tx
      .select({ id: authUser.id, email: authUser.email })
      .from(authUser)
      .where(and(inArray(authUser.id, userIds), eq(authUser.emailVerified, true))),
  );
  return new Map(rows.filter((row) => !isSyntheticEmail(row.email)).map((row) => [row.id, row.email]));
}

/**
 * Смена роли участника сотрудником (FR-ID-13). Роль отмечается выданной вручную: вход через Smartup
 * её не меняет. Одна транзакция с записью member.role_changed: не записался журнал, не меняется и роль.
 */
export async function changeMemberRoleTx(actor: StaffActor, orgId: string, userId: string, role: ClientRole): Promise<void> {
  await withIdentity(actor, async (tx) => {
    const current = (
      await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
        .limit(1)
        .for('update')
    )[0];
    if (!current) throw new HduError('not_found');
    if (current.role === role) return;
    await tx
      .update(memberships)
      .set({ role, isRoleManual: true })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    await writeAudit(tx, {
      action: 'member.role_changed',
      objectType: 'membership',
      objectId: userId,
      orgId,
      diff: { from: current.role, to: role },
    });
  });
}

/**
 * Имена пользователей по идентификаторам через представление hdu_user_profiles: клиент получает имена
 * участников своей организации и сотрудников, остальных представление не отдаёт (раздел 10.3).
 */
export async function namesOf(actor: Actor, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await withActor(actor, (tx) =>
    tx.select({ userId: userProfiles.userId, name: userProfiles.name }).from(userProfiles).where(inArray(userProfiles.userId, [...new Set(userIds)])),
  );
  return new Map(rows.map((row) => [row.userId, row.name]));
}
