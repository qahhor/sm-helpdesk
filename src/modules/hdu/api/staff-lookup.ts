import 'server-only';
import { findVerifiedEmails } from '../core/members';
import { findOrgIdsTx, findUserIdsTx, type OrgSummary, orgSummariesTx } from '../core/staff-lookup';
import type { StaffContext } from './session';

// Поиск организаций и людей для рабочего места (FR-AG-10). Только сотрудник: контекст сотрудника строит
// requireStaffActor, клиенту эти функции недоступны.

export type { OrgSummary } from '../core/staff-lookup';

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
