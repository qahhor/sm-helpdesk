import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { type ClientActor, type StaffActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { HduError } from '../error';
import type { ClientRole, MembershipSource, RecordState } from '../pref';
import { memberships, organizations, userProfiles } from '../schema';

// Модуль hdu, слой core: участники организации. Чтение через hub_app и политики чтения,
// изменение через hub_auth от имени актора: политики базы страхуют проверку прав в слое api.

export type MemberRow = { userId: string; name: string; role: ClientRole; source: MembershipSource; state: RecordState };

/** Участники организации с именами. Адресов и других полей учётной записи здесь нет. */
export async function listOrgMembers(actor: ClientActor | StaffActor, orgId: string): Promise<MemberRow[]> {
  return withActor(actor, (tx) =>
    tx
      .select({
        userId: memberships.userId,
        name: userProfiles.name,
        role: memberships.role,
        source: memberships.source,
        state: memberships.state,
      })
      .from(memberships)
      .innerJoin(userProfiles, eq(userProfiles.userId, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(memberships.state), asc(userProfiles.name), asc(memberships.userId)),
  );
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
