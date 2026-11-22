import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, pgView, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { ClientRole, MembershipSource, RecordState, ServerIssue, StaffRole } from './pref';

// Модуль hdu: идентичность. Таблицы, ограничения, триггеры и политики RLS создаёт миграция
// drizzle/0005_hdu_tables.sql. Здесь только описание колонок для запросов.
//
// Читать можно под ролью hub_app (withActor), менять только под ролью hub_auth (withIdentity).

const moment = (name: string) => timestamp(name, { withTimezone: true });

/** Явные адреса сервера входа, если у него нет документа discovery. */
export type OidcEndpoints = { authorization: string; token: string; userinfo: string; jwks: string };

/** Реестр серверов Smartup. Секрет клиента OAuth хранится зашифрованным и под ролью hub_app не читается. */
export const servers = pgTable('hdu_servers', {
  serverId: uuid('server_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  issuer: text('issuer').notNull(),
  oauthClientId: text('oauth_client_id').notNull(),
  oauthClientSecret: text('oauth_client_secret').notNull(),
  oidcEndpoints: jsonb('oidc_endpoints').$type<OidcEndpoints>(),
  roleMap: jsonb('role_map').$type<Record<string, ClientRole>>().notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  state: text('state').$type<RecordState>().notNull().default('active'),
  code: text('code').notNull(),
  ...stampColumns,
});

/** Результат последней проверки связи с сервером (FR-ADM-01). Отдельно от реестра: проверка не меняет настройки входа. */
export const serverChecks = pgTable('hdu_server_checks', {
  serverId: uuid('server_id').primaryKey(),
  isOk: boolean('is_ok').notNull(),
  issues: text('issues').array().$type<ServerIssue[]>().notNull().default(sql`'{}'`),
  checkedOn: moment('checked_on').notNull().defaultNow(),
  ...stampColumns,
});

/** Организации клиентов: пара "сервер и идентификатор компании". */
export const organizations = pgTable('hdu_organizations', {
  orgId: uuid('org_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  // У служебной организации "Неопознанные" сервера нет (миграция 0035).
  serverId: uuid('server_id'),
  externalCompanyId: text('external_company_id'),
  name: text('name').notNull(),
  inn: text('inn'),
  category: text('category').$type<'A' | 'B' | 'C' | 'D'>(),
  isAiEnabled: boolean('is_ai_enabled').notNull().default(true),
  state: text('state').$type<RecordState>().notNull().default('active'),
  ...stampColumns,
  kind: text('kind').$type<'client' | 'service'>().notNull().default('client'),
});

/** Кто в какой организации состоит. */
export const memberships = pgTable(
  'hdu_memberships',
  {
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').$type<ClientRole>().notNull().default('client_user'),
    source: text('source').$type<MembershipSource>().notNull(),
    isRoleManual: boolean('is_role_manual').notNull().default(false),
    state: text('state').$type<RecordState>().notNull().default('active'),
    ...stampColumns,
  },
  (table) => [primaryKey({ name: 'hdu_memberships_pk', columns: [table.orgId, table.userId] })],
);

/** Сотрудники Smartup. */
export const staff = pgTable('hdu_staff', {
  userId: uuid('user_id').primaryKey(),
  role: text('role').$type<StaffRole>().notNull(),
  isLead: boolean('is_lead').notNull().default(false),
  state: text('state').$type<RecordState>().notNull().default('active'),
  ...stampColumns,
});

/** Приглашения: в организацию клиента (orgId задан) и сотрудников (orgId пуст). Токен хранится хешем. */
export const invitations = pgTable('hdu_invitations', {
  orgId: uuid('org_id'),
  invitationId: uuid('invitation_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  email: text('email').notNull(),
  role: text('role').$type<ClientRole | StaffRole>().notNull(),
  name: text('name'),
  isLead: boolean('is_lead').notNull().default(false),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by'),
  expiresOn: moment('expires_on').notNull(),
  acceptedOn: moment('accepted_on'),
  revokedOn: moment('revoked_on'),
  ...stampColumns,
  /** Гость из письма: при принятии его обращения переходят принявшему (миграция 0035, решение 13 вехи M4). */
  guestUserId: uuid('guest_user_id'),
});

/** Одноразовые ссылки подтверждения адреса. */
export const emailTokens = pgTable('hdu_email_tokens', {
  tokenId: uuid('token_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresOn: moment('expires_on').notNull(),
  usedOn: moment('used_on'),
  ...stampColumns,
});

/** Аккаунты пользователя в каналах связи: сейчас только Telegram (миграция 0006). */
export const contactIdentities = pgTable('hdu_contact_identities', {
  identityId: uuid('identity_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  kind: text('kind').$type<'telegram'>().notNull(),
  externalId: text('external_id').notNull(),
  displayName: text('display_name'),
  verified: text('verified').$type<'linked'>().notNull(),
  verifiedOn: moment('verified_on').notNull(),
  isBlocked: boolean('is_blocked').notNull().default(false),
  ...stampColumns,
});

/** Одноразовые коды привязки канала. Код хранится хешем. */
export const linkCodes = pgTable('hdu_link_codes', {
  linkCodeId: uuid('link_code_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  kind: text('kind').$type<'telegram'>().notNull(),
  codeHash: text('code_hash').notNull(),
  expiresOn: moment('expires_on').notNull(),
  usedOn: moment('used_on'),
  ...stampColumns,
});

/** Одноразовые ссылки запасного входа из канала связи. Токен хранится хешем. */
export const loginCodes = pgTable('hdu_login_codes', {
  loginCodeId: uuid('login_code_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  channel: text('channel').$type<'telegram'>().notNull(),
  codeHash: text('code_hash').notNull(),
  expiresOn: moment('expires_on').notNull(),
  usedOn: moment('used_on'),
  ...stampColumns,
});

/**
 * Профили для показа рядом с записями: идентификатор, имя, признак сотрудника.
 * Представление само ограничивает строки по актору (миграция 0005).
 */
export const userProfiles = pgView('hdu_user_profiles', {
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  isStaff: boolean('is_staff').notNull(),
}).existing();

export type Server = typeof servers.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type StaffRow = typeof staff.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;

/** Гость стал пользователем (решение 13 вехи M4): обращения гостя переходят пользователю задачей раз в минуту. */
export const guestMerges = pgTable('hdu_guest_merges', {
  mergeId: uuid('merge_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  guestUserId: uuid('guest_user_id').notNull(),
  userId: uuid('user_id').notNull(),
  appliedOn: moment('applied_on'),
  ...stampColumns,
});

/** Домены почты организаций (FR-EM-06). */
export const orgEmailDomains = pgTable(
  'hdu_org_email_domains',
  {
    orgId: uuid('org_id').notNull(),
    domain: text('domain').notNull(),
    addedBy: uuid('added_by').notNull(),
    ...stampColumns,
  },
  (table) => [primaryKey({ name: 'hdu_org_email_domains_pk', columns: [table.orgId, table.domain] })],
);
