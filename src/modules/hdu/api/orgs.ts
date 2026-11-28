import 'server-only';
import { searchable } from '@/modules/hdc/pref';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';
import type { Locale } from '@/i18n/locales';
import { z } from 'zod';
import {
  getOrgRow,
  type OrgAiProfile,
  agentRedactionTermsOf,
  type AgentRedactionTerms,
  orgAiProfileOf,
  type OrgFacts,
  orgFactsOf,
  loadClientAccess,
  type MyOrganization,
  type OrgRow,
  searchOrgs,
  setActiveOrganization,
  setOrgAiProcessingOf,
  updateOrgSettings,
} from '../core/orgs';
import { addOrgDomainTx, listOrgDomainsTx, removeOrgDomainTx } from '../core/domains';
import { HduError } from '../error';
import { AI_CONSENT_REF_MAX, PUBLIC_MAIL_DOMAINS } from '../pref';
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
  /** Когда клиент подтвердил личность в этой сессии: по этому времени считается недавний вход (решения 0067 и 0083). */
  freshAuthAt: Date | null;
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
    freshAuthAt: session.session.freshAuthAt,
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
export async function searchOrganizations(ctx: StaffContext, input: unknown): Promise<{ items: OrgRow[]; hasMore: boolean; searchTooShort: boolean }> {
  requireHumanStaff(ctx);
  const parsed = searchInput.safeParse(input ?? {});
  if (!parsed.success) throw new HduError('invalid_input');
  const page = parsed.data.page ?? 1;
  const query = parsed.data.query ?? '';
  // Запрос из одного-двух знаков не ищется (аудит 23.11.2026, находка P9); пустой показывает все организации.
  if (query && !searchable(query)) return { items: [], hasMore: false, searchTooShort: true };
  const rows = await searchOrgs(ctx.actor, { query, offset: (page - 1) * ORG_PAGE_SIZE, limit: ORG_PAGE_SIZE });
  return { items: rows.slice(0, ORG_PAGE_SIZE), hasMore: rows.length > ORG_PAGE_SIZE, searchTooShort: false };
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
  })
  .strict();

function requireOrgManager(ctx: StaffContext, now: Date): StaffActor {
  const actor = ctx?.actor;
  if (actor?.type !== 'staff' || (actor.staffRole !== 'care' && actor.staffRole !== 'admin')) throw new HduError('forbidden');
  // Категория и AI-обработка меняют, что уходит в AI и как обслуживается клиент: свежий вход (проверка main, Q18).
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  return actor;
}

/** Категория клиента (FR-ADM-02): care и admin. Запись org.updated в той же транзакции. */
export async function updateOrganization(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = requireOrgManager(ctx, now);
  const { orgId, ...settings } = parseInput(settingsInput, input);
  if (!(await updateOrgSettings(actor, orgId, settings))) throw new HduError('not_found');
}

/** Сегодняшняя дата по Ташкенту, ГГГГ-ММ-ДД: позже неё отметка согласия не ставится. */
function todayInTashkent(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const aiProcessingInput = (now: Date) =>
  z.discriminatedUnion('enabled', [
    z.strictObject({
      orgId: uuidInput,
      enabled: z.literal(true),
      consentOn: z.iso.date().refine((day) => day >= '2020-01-01' && day <= todayInTashkent(now)),
      consentRef: z.string().trim().min(1).max(AI_CONSENT_REF_MAX),
    }),
    z.strictObject({ orgId: uuidInput, enabled: z.literal(false) }),
  ]);

/**
 * AI-обработка организации (план M9, задача 2, решение 10; решение ТЗ 88): care и admin со свежим входом. Включение
 * только с отметкой согласия: дата не позже сегодняшней и основание до 200 знаков; отметка и журнал
 * org.ai_consent_recorded одной транзакцией. Выключение пишет org.ai_disabled.
 */
export async function setOrgAiProcessing(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = requireOrgManager(ctx, now);
  const parsed = parseInput(aiProcessingInput(now), input);
  if (!(await setOrgAiProcessingOf(actor, parsed))) throw new HduError('not_found');
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

// --- Домены почты организации (FR-EM-06, план M4, задача 12) ---

const DOMAIN_MANAGERS = new Set(['care', 'admin']);
const domainInput = z.object({
  orgId: uuidInput,
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
    .refine((domain) => !PUBLIC_MAIL_DOMAINS.has(domain)),
});

/** Домены организации: видят все сотрудники-люди. */
export async function listOrgDomains(ctx: StaffContext, orgId: unknown): Promise<string[]> {
  requireHumanStaff(ctx);
  return listOrgDomainsTx(ctx.actor, parseInput(uuidInput, orgId));
}

/** Домен почты организации: Customer Care и администратор. Домен общей почтовой службы не принимается. */
export async function addOrgDomain(ctx: StaffContext, input: unknown): Promise<void> {
  if (!DOMAIN_MANAGERS.has(ctx.actor.staffRole)) throw new HduError('forbidden');
  // Домен решает, чьим считается письмо: меняет его только свежий вход (итоговая проверка W0, M6).
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const { orgId, domain } = parseInput(domainInput, input);
  if (!(await getOrgRow(ctx.actor, orgId))) throw new HduError('not_found');
  await addOrgDomainTx(ctx.actor, orgId, domain);
}

export async function removeOrgDomain(ctx: StaffContext, input: unknown): Promise<void> {
  if (!DOMAIN_MANAGERS.has(ctx.actor.staffRole)) throw new HduError('forbidden');
  // Домен решает, чьим считается письмо: меняет его только свежий вход (итоговая проверка W0, M6).
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const { orgId, domain } = parseInput(domainInput.extend({ domain: z.string().trim().toLowerCase().max(253) }), input);
  await removeOrgDomainTx(ctx.actor, orgId, domain);
}

/**
 * Профиль организации для отбора данных модели (план M5, задача 5): признак AI-обработки, название и ИНН, имена
 * участников. Только система (задачи фонового процесса) и сотрудник; клиенту функция не дана.
 */
export async function orgAiProfile(actor: SystemActor | StaffActor, input: { orgId: string; userIds: readonly string[] }): Promise<OrgAiProfile | null> {
  if (actor.type !== 'system' && actor.type !== 'staff') throw new HduError('forbidden');
  const orgId = z.uuid().parse(input.orgId);
  const userIds = z.array(z.uuid()).max(500).parse(input.userIds);
  return orgAiProfileOf(actor, orgId, userIds);
}

/**
 * Слова обезличивания ответа сервера MCP (веха M8b, решение 8; находка I1): только система, до 200 организаций и
 * 5000 людей обращений за вызов.
 */
export async function agentRedactionTerms(actor: SystemActor, input: { orgIds: readonly string[]; userIds?: readonly string[] }): Promise<AgentRedactionTerms> {
  if (actor.type !== 'system') throw new HduError('forbidden');
  return agentRedactionTermsOf(actor, {
    orgIds: z.array(z.uuid()).max(200).parse([...new Set(input.orgIds)]),
    userIds: z.array(z.uuid()).max(5000).parse([...new Set(input.userIds ?? [])]),
  });
}

/**
 * Сведения организаций для известных проблем (план M5c, задачи 2 и 5): категории в сведениях проблемы, названия и ИНН
 * для проверки публичного текста. Только система и сотрудник; клиенту функция не дана.
 */
export async function orgFacts(actor: SystemActor | StaffActor, orgIds: readonly string[]): Promise<OrgFacts[]> {
  if (actor.type !== 'system' && actor.type !== 'staff') throw new HduError('forbidden');
  return orgFactsOf(actor, z.array(z.uuid()).max(10_000).parse(orgIds));
}
