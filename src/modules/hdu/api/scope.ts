import 'server-only';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import type { ClientContext } from './orgs';
import type { StaffContext } from './session';

// Область действия над организацией: кто действует и в какой организации.
// Организация клиента берётся только из его актора (из членства). Сотрудник называет организацию сам,
// его права проверяет роль: Customer Care и администратор портала (FR-ID-13, FR-ADM-02).

export type OrgScope = { ctx: ClientContext } | { ctx: StaffContext; orgId: string };

export type ResolvedScope = {
  actor: ClientActor | StaffActor;
  orgId: string;
  /** Кто действует: себя участник отключить не может. */
  selfId: string;
  /** Имя действующего: для письма приглашения. */
  actorName: string;
  /** Название организации, если оно уже известно из актора клиента. */
  orgName: string | null;
};

const STAFF_MANAGERS = new Set(['care', 'admin']);

/** Управление участниками и приглашениями: администратор клиента в своей организации, care и admin в любой. */
export function manageScope(scope: OrgScope): ResolvedScope {
  const { ctx } = scope;
  if (ctx.actor.type === 'client') {
    if (ctx.actor.orgRole !== 'client_admin') throw new HduError('forbidden');
    const client = ctx as ClientContext;
    return { actor: ctx.actor, orgId: ctx.actor.orgId, selfId: ctx.actor.userId, actorName: client.user.name, orgName: client.org.name };
  }
  if (!STAFF_MANAGERS.has(ctx.actor.staffRole)) throw new HduError('forbidden');
  const orgId = parseInput(uuidInput, 'orgId' in scope ? scope.orgId : undefined);
  return { actor: ctx.actor, orgId, selfId: ctx.actor.userId, actorName: ctx.user.name, orgName: null };
}
