import 'server-only';
import type { ClientActor } from '@/db/with-actor';
import { loadClientAccess, type MyOrganization, setActiveOrganization } from '../core/orgs';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import { isSyntheticEmail } from '../util';
import type { SessionData } from './request';

// Актор клиента из проверенной сессии (ТЗ 11.1, FR-ID-05). Функции этого файла не зависят от Next.js:
// их вызывают страницы (через api/actor.ts) и тесты.
//
// Организация и роль берутся только из действующего членства. Поле activeOrgId сессии лишь подсказывает,
// какую из организаций пользователя показать: чужая или отключённая там не пройдёт.

export type ClientContext = {
  actor: ClientActor;
  user: { id: string; name: string; hasVerifiedEmail: boolean; onboarded: boolean };
  org: { id: string; name: string };
  /** Сколько у пользователя действующих организаций: больше одной, и в шапке появляется переключатель. */
  orgCount: number;
};

export type ClientDenial = { denied: 'no_session' | 'staff' | 'no_organization' | 'choose_organization' };

export type { MyOrganization };

/**
 * Актор клиента по сессии. Порядок выбора организации:
 * активная организация сессии, затем организация последнего входа, затем единственная.
 * Несколько без выбора: choose_organization. Ни одной: no_organization. Сотрудник актора клиента не получает.
 */
export async function resolveClient(session: SessionData | null): Promise<ClientContext | ClientDenial> {
  if (!session) return { denied: 'no_session' };
  const { isStaff, orgs } = await loadClientAccess(session.user.id);
  if (isStaff) return { denied: 'staff' };

  const find = (orgId: string | null) => (orgId ? orgs.find((org) => org.orgId === orgId) : undefined);
  let org = find(session.session.activeOrgId);
  if (!org) {
    org = find(session.user.lastOrgId) ?? (orgs.length === 1 ? orgs[0] : undefined);
    if (!org) return { denied: orgs.length > 0 ? 'choose_organization' : 'no_organization' };
    await setActiveOrganization({ sessionId: session.session.id, userId: session.user.id }, org.orgId, { remember: false });
  }

  return {
    actor: { type: 'client', userId: session.user.id, orgId: org.orgId, orgRole: org.role },
    user: {
      id: session.user.id,
      name: session.user.name,
      hasVerifiedEmail: session.user.emailVerified && !isSyntheticEmail(session.user.email),
      onboarded: session.user.onboardedAt !== null,
    },
    org: { id: org.orgId, name: org.name },
    orgCount: orgs.length,
  };
}

/** Организации, где пользователь действующий участник. Чужих и отключённых здесь нет. */
export async function listMyOrganizations(userId: string): Promise<MyOrganization[]> {
  return (await loadClientAccess(userId)).orgs;
}

/**
 * Переключает активную организацию сессии и запоминает её как организацию последнего входа.
 * Идентификатор организации приходит из формы: принимается только организация с действующим членством.
 */
export async function switchOrganization(session: SessionData, orgId: unknown): Promise<void> {
  const id = parseInput(uuidInput, orgId);
  const { isStaff, orgs } = await loadClientAccess(session.user.id);
  if (isStaff || !orgs.some((org) => org.orgId === id)) throw new HduError('not_member');
  await setActiveOrganization({ sessionId: session.session.id, userId: session.user.id }, id, { remember: true });
}
