import 'server-only';
import { z } from 'zod';
import { changeMemberRoleTx, changeMemberState, findVerifiedEmails, listOrgMembers } from '../core/members';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import { CLIENT_ROLES, type ClientRole, type MembershipSource, RECORD_STATES, type RecordState } from '../pref';
import { manageScope, type OrgScope, requireHumanStaff } from './scope';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Участники организации: список и отключение (FR-ID-13, пункт 12 таблицы решений M1, решение 0014).

export type MemberView = { userId: string; name: string; role: ClientRole; source: MembershipSource; state: RecordState; isSelf: boolean };

/** Участники организации: администратору клиента своей, care и admin любой. */
export async function listMembers(scope: OrgScope): Promise<MemberView[]> {
  const s = manageScope(scope);
  const rows = await listOrgMembers(s.actor, s.orgId);
  return rows.map((row) => ({ ...row, isSelf: row.userId === s.selfId }));
}

const stateInput = z.object({ userId: uuidInput, state: z.enum(RECORD_STATES) });

/**
 * Отключить или снова включить участника. Себя нельзя. Сессии отключённого не удаляются:
 * доступ закрывает проверка членства на каждом запросе.
 */
export async function setMemberState(scope: OrgScope, input: unknown): Promise<void> {
  const s = manageScope(scope);
  const parsed = stateInput.safeParse(input);
  if (!parsed.success) throw new HduError('invalid_input');
  if (parsed.data.userId === s.selfId) throw new HduError('forbidden');
  await changeMemberState(s.actor, s.orgId, parsed.data.userId, parsed.data.state);
}

/** Участники организации в рабочем месте: все сотрудники-люди. Адрес только подтверждённый. */
export async function listMembersForStaff(ctx: StaffContext, orgId: unknown): Promise<(MemberView & { email: string | null })[]> {
  requireHumanStaff(ctx);
  const rows = await listOrgMembers(ctx.actor, parseInput(uuidInput, orgId));
  const emails = await findVerifiedEmails(rows.map((row) => row.userId));
  return rows.map((row) => ({ ...row, isSelf: false, email: emails.get(row.userId) ?? null }));
}

const roleInput = z.object({ orgId: uuidInput, userId: uuidInput, role: z.enum(CLIENT_ROLES) });

/**
 * Смена роли участника: care и admin (FR-ID-13, FR-ADM-02). Действие администратора: вход не старше
 * 15 минут, иначе stale_session (ТЗ 14.3, решение 0014).
 */
export async function changeMemberRole(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  if (ctx.actor.staffRole !== 'care' && ctx.actor.staffRole !== 'admin') throw new HduError('forbidden');
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const parsed = roleInput.safeParse(input);
  if (!parsed.success) throw new HduError('invalid_input');
  await changeMemberRoleTx(ctx.actor, parsed.data.orgId, parsed.data.userId, parsed.data.role);
}
