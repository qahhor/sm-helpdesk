import 'server-only';
import { z } from 'zod';
import { changeMemberState, listOrgMembers } from '../core/members';
import { HduError } from '../error';
import { uuidInput } from '../input';
import { type ClientRole, type MembershipSource, RECORD_STATES, type RecordState } from '../pref';
import { manageScope, type OrgScope } from './scope';

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
