import 'server-only';
import { z } from 'zod';
import { changeMemberRoleTx, changeMemberState, findOrgMember, findVerifiedEmails, type MemberKey, pageOrgMembers } from '../core/members';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import { CLIENT_ROLES, type ClientRole, type MembershipSource, RECORD_STATES, type RecordState } from '../pref';
import { manageScope, type OrgScope, requireHumanStaff } from './scope';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Участники организации: список и отключение (FR-ID-13, пункт 12 таблицы решений M1, решение 0014).

export type MemberView = { userId: string; name: string; role: ClientRole; source: MembershipSource; state: RecordState; isSelf: boolean };

/** Размер страницы списка участников и наибольший размер, который может запросить вызывающий. */
export const MEMBERS_PAGE = 50;
export const MEMBERS_PAGE_MAX = 200;

const pageInput = z.strictObject({
  q: z.string().trim().max(100).nullish(),
  after: z.string().max(600).nullish(),
  limit: z.number().int().min(1).max(MEMBERS_PAGE_MAX).optional(),
  state: z.enum(RECORD_STATES).optional(),
});
const keyInput = z.tuple([z.enum(RECORD_STATES), z.string().max(300), uuidInput]);

/** Ключ листания непрозрачной строкой для адреса страницы. Он только место в списке: прав не даёт. */
const encodeKey = (row: MemberKey): string => Buffer.from(JSON.stringify([row.state, row.name, row.userId])).toString('base64url');

function decodeKey(text: string): MemberKey {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new HduError('invalid_input');
  }
  const parsed = keyInput.safeParse(raw);
  if (!parsed.success) throw new HduError('invalid_input');
  return { state: parsed.data[0], name: parsed.data[1], userId: parsed.data[2] };
}

export type MembersPage<T> = { members: T[]; /** Ключ следующей страницы или null, если это последняя. */ next: string | null };

async function page(actor: Parameters<typeof pageOrgMembers>[0], orgId: string, input: unknown): Promise<{ rows: Awaited<ReturnType<typeof pageOrgMembers>>; next: string | null }> {
  const parsed = pageInput.safeParse(input ?? {});
  if (!parsed.success) throw new HduError('invalid_input');
  const limit = parsed.data.limit ?? MEMBERS_PAGE;
  const rows = await pageOrgMembers(actor, orgId, {
    q: parsed.data.q || null,
    after: parsed.data.after ? decodeKey(parsed.data.after) : null,
    limit,
    ...(parsed.data.state ? { state: parsed.data.state } : {}),
  });
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { rows: shown, next: rows.length > limit && last ? encodeKey(last) : null };
}

/**
 * Участники организации страницей (проверка качества, Q20): администратору клиента своей, care и admin любой.
 * q ищет по имени, after продолжает список с ключа прошлой страницы.
 */
export async function pageMembers(scope: OrgScope, input: unknown = {}): Promise<MembersPage<MemberView>> {
  const s = manageScope(scope);
  const { rows, next } = await page(s.actor, s.orgId, input);
  return { members: rows.map((row) => ({ ...row, isSelf: row.userId === s.selfId })), next };
}

/**
 * Первые участники организации одним списком, не больше MEMBERS_PAGE_MAX. Для мест, где нужен короткий список целиком;
 * страницы показывают участников через pageMembers.
 */
export async function listMembers(scope: OrgScope): Promise<MemberView[]> {
  return (await pageMembers(scope, { limit: MEMBERS_PAGE_MAX })).members;
}

/** Один участник организации по идентификатору (окно подтверждения отключения) или null. */
export async function memberOfOrg(scope: OrgScope, userId: unknown): Promise<MemberView | null> {
  const s = manageScope(scope);
  const id = uuidInput.safeParse(userId);
  if (!id.success) return null;
  const row = await findOrgMember(s.actor, s.orgId, id.data);
  return row ? { ...row, isSelf: row.userId === s.selfId } : null;
}

const stateInput = z.object({ userId: uuidInput, state: z.enum(RECORD_STATES) });

/**
 * Отключить или снова включить участника. Себя нельзя. Сессии отключённого не удаляются:
 * доступ закрывает проверка членства на каждом запросе.
 */
export async function setMemberState(scope: OrgScope, input: unknown, now: Date = new Date()): Promise<void> {
  const s = manageScope(scope);
  // Сотрудник отключает участника клиента только со свежим входом, как при смене роли (проверка main, Q18).
  if (scope.ctx.actor.type === 'staff' && !isFresh(scope.ctx as StaffContext, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const parsed = stateInput.safeParse(input);
  if (!parsed.success) throw new HduError('invalid_input');
  if (parsed.data.userId === s.selfId) throw new HduError('forbidden');
  await changeMemberState(s.actor, s.orgId, parsed.data.userId, parsed.data.state);
}

/** Участники организации в рабочем месте страницей: все сотрудники-люди. Адрес только подтверждённый. */
export async function pageMembersForStaff(ctx: StaffContext, orgId: unknown, input: unknown = {}): Promise<MembersPage<MemberView & { email: string | null }>> {
  requireHumanStaff(ctx);
  const { rows, next } = await page(ctx.actor, parseInput(uuidInput, orgId), input);
  const emails = await findVerifiedEmails(rows.map((row) => row.userId));
  return { members: rows.map((row) => ({ ...row, isSelf: false, email: emails.get(row.userId) ?? null })), next };
}

/** Один участник организации для сотрудника или null: проверка автора обращения, окна подтверждения. */
export async function memberForStaff(ctx: StaffContext, orgId: unknown, userId: unknown): Promise<MemberView | null> {
  requireHumanStaff(ctx);
  const id = uuidInput.safeParse(userId);
  if (!id.success) return null;
  const row = await findOrgMember(ctx.actor, parseInput(uuidInput, orgId), id.data);
  return row ? { ...row, isSelf: false } : null;
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
