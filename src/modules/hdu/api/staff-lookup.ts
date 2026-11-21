import 'server-only';
import { findVerifiedEmails } from '../core/members';
import { type AssignableStaff, assignableStaffTx, findOrgIdsTx, findUserIdsTx, type OrgSummary, orgSummariesTx } from '../core/staff-lookup';
import type { StaffContext } from './session';

// Поиск организаций и людей для рабочего места (FR-AG-10). Только сотрудник: контекст сотрудника строит
// requireStaffActor, клиенту эти функции недоступны.

export type { AssignableStaff, OrgSummary } from '../core/staff-lookup';

const clean = (query: string) => query.trim().slice(0, 200);

export function findOrgIds(ctx: StaffContext, query: string): Promise<string[]> {
  return clean(query) ? findOrgIdsTx(ctx.actor, clean(query)) : Promise.resolve([]);
}

export function findUserIds(ctx: StaffContext, query: string): Promise<string[]> {
  return clean(query) ? findUserIdsTx(ctx.actor, clean(query)) : Promise.resolve([]);
}

export function orgSummaries(ctx: StaffContext, orgIds: string[]): Promise<Map<string, OrgSummary>> {
  return orgSummariesTx(ctx.actor, orgIds);
}

/** Подтверждённые адреса людей для карточки обращения. Служебных адресов без почты нет. */
export function verifiedEmails(_ctx: StaffContext, userIds: string[]): Promise<Map<string, string>> {
  return findVerifiedEmails(userIds);
}

/** На кого можно назначить обращение (FR-AG-02): действующие сотрудники, кроме роли product. Самой роли product список не нужен. */
export async function listAssignableStaff(ctx: StaffContext): Promise<AssignableStaff[]> {
  if (ctx.actor.staffRole === 'product') return [];
  return assignableStaffTx();
}
