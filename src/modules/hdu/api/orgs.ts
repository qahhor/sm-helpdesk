import 'server-only';
import type { ClientActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { z } from 'zod';
import {
  getOrgRow,
  loadClientAccess,
  type MyOrganization,
  type OrgRow,
  searchOrgs,
  setActiveOrganization,
  updateOrgSettings,
} from '../core/orgs';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import { requireHumanStaff } from './scope';
import { isSyntheticEmail } from '../util';
import type { SessionData } from './request';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Актор клиента из проверенной сессии (ТЗ 11.1, FR-ID-05). Функции этого файла не зависят от Next.js:
// их вызывают страницы (через api/actor.ts) и тесты.
//
// Организация и роль берутся только из действующего членства. Поле activeOrgId сессии лишь подсказывает,
// какую из организаций пользователя показать: чужая или отключённая там не пройдёт.

export type ClientContext = {
  actor: ClientActor;
  user: {
    id: string;
    name: string;
    /** Подтверждённый адрес для входа по ссылке. Пусто, пока адрес не подтверждён. */
    email: string | null;
    /** Адрес из Smartup или указанный пользователем, ещё не подтверждённый. */
    claimedEmail: string | null;
    hasVerifiedEmail: boolean;
    onboarded: boolean;
    /** Язык писем и сообщений бота из учётной записи. */
    locale: Locale | null;
    /** Версия политики обработки данных, которую пользователь видел. */
    policyVersion: string | null;
  };
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

  const hasVerifiedEmail = session.user.emailVerified && !isSyntheticEmail(session.user.email);
  return {
    actor: { type: 'client', userId: session.user.id, orgId: org.orgId, orgRole: org.role },
    user: {
      id: session.user.id,
      name: session.user.name,
      email: hasVerifiedEmail ? session.user.email : null,
      claimedEmail: session.user.claimedEmail,
      hasVerifiedEmail,
      locale: session.user.locale,
      policyVersion: session.user.policyVersion,
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

// --- Организации в рабочем месте (FR-ID-13): все сотрудники-люди видят все организации ---

export type { OrgRow };

const ORG_PAGE_SIZE = 50;
const searchInput = z.object({
  query: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});

/** Поиск по названию, ИНН и идентификатору компании. По 50 строк, hasMore: есть следующая страница. */
export async function searchOrganizations(ctx: StaffContext, input: unknown): Promise<{ items: OrgRow[]; hasMore: boolean }> {
  requireHumanStaff(ctx);
  const parsed = searchInput.safeParse(input ?? {});
  if (!parsed.success) throw new HduError('invalid_input');
  const page = parsed.data.page ?? 1;
  const rows = await searchOrgs(ctx.actor, { query: parsed.data.query ?? '', offset: (page - 1) * ORG_PAGE_SIZE, limit: ORG_PAGE_SIZE });
  return { items: rows.slice(0, ORG_PAGE_SIZE), hasMore: rows.length > ORG_PAGE_SIZE };
}

/** Карточка организации. Неверный или неизвестный идентификатор: пусто (страница отвечает 404). */
export async function getOrganization(ctx: StaffContext, orgId: unknown): Promise<OrgRow | null> {
  requireHumanStaff(ctx);
  const parsed = uuidInput.safeParse(orgId);
  return parsed.success ? getOrgRow(ctx.actor, parsed.data) : null;
}

const settingsInput = z
  .object({
    orgId: uuidInput,
    category: z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
    isAiEnabled: z.boolean().optional(),
  })
  .strict();

/** Категория клиента и отключение AI-обработки (FR-ADM-02): care и admin. Запись org.updated в той же транзакции. */
export async function updateOrganization(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = ctx?.actor;
  if (actor?.type !== 'staff' || (actor.staffRole !== 'care' && actor.staffRole !== 'admin')) throw new HduError('forbidden');
  // Категория и AI-обработка меняют, что уходит в AI и как обслуживается клиент: свежий вход (проверка main, Q18).
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const { orgId, ...settings } = parseInput(settingsInput, input);
  if (!(await updateOrgSettings(actor, orgId, settings))) throw new HduError('not_found');
}

/**
 * Акторы пользователя в других его организациях, где он действующий участник (не гость). Нужны странице
 * обращения: ссылка из письма может вести в обращение другой организации, и вместо "не найдено" страница
 * предлагает переключиться (UX-C-06). Организации берутся из членств пользователя, а не из запроса.
 */
export async function otherOrganizationActors(ctx: ClientContext): Promise<{ orgId: string; name: string; actor: ClientActor }[]> {
  const { orgs } = await loadClientAccess(ctx.actor.userId);
  return orgs
    .filter((org) => org.orgId !== ctx.actor.orgId)
    .map((org) => ({ orgId: org.orgId, name: org.name, actor: { ...ctx.actor, orgId: org.orgId, orgRole: org.role } }));
}
