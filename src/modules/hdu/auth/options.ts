import 'server-only';
import { sso, type SSOUserResolution, type SSOUserResolutionContext, type SSOUserResolutionInput } from '@better-auth/sso';
import type { BetterAuthOptions } from 'better-auth';
import { magicLink, twoFactor } from 'better-auth/plugins';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import {
  LOGIN_LINK_TTL_SEC,
  AUTH_COOKIE_PREFIX,
  SESSION_TTL_SEC,
  SESSION_UPDATE_AGE_SEC,
  TOTP_LOCK_SEC,
  TOTP_MAX_FAILED_ATTEMPTS,
} from '../pref';
import { beforeHook, createSessionHooks, type StaffLookup } from './hooks';
import { type SsoServer, toSsoProviders, trustedOriginsFor } from './sso-providers';
import { hubTrusted } from './trusted';

// Настройки библиотеки входа Better Auth (ТЗ 11.2, решение 0012).
// Всё, что зависит от окружения и от остальных частей модуля, приходит параметрами:
// так настройки собираются и в приложении, и в тестах.

export type SendMagicLink = (data: { email: string; url: string; token: string; metadata?: unknown }) => Promise<void>;
export type ResolveSmartupUser = (
  input: SSOUserResolutionInput,
  context: SSOUserResolutionContext,
) => Promise<SSOUserResolution>;
export type ProvisionSmartupUser = (data: {
  user: { id: string } & Record<string, unknown>;
  userInfo: Record<string, unknown>;
  provider: { providerId: string };
}) => Promise<void>;

export type AuthDeps = {
  /** Пул соединений роли hub_auth. */
  pool: Pool;
  secret: string;
  /** Адрес портала (HUB_URL). */
  baseUrl: string;
  /** Действующие серверы Smartup из реестра, секреты расшифрованы. */
  servers: readonly SsoServer[];
  staff: StaffLookup;
  sendMagicLink: SendMagicLink;
  resolveUser: ResolveSmartupUser;
  provisionUser: ProvisionSmartupUser;
};

export function buildAuthOptions(deps: AuthDeps) {
  return {
    appName: 'Smartup Hub',
    // Таблицы библиотеки лежат в схеме auth. Транзакции нужны входу через сервер Smartup:
    // без них библиотека не даёт порталу самому решать, какой это пользователь.
    database: { dialect: new PostgresDialect({ pool: deps.pool }), type: 'postgres', schemaName: 'auth', transaction: true },
    secret: deps.secret,
    baseURL: deps.baseUrl,
    trustedOrigins: trustedOriginsFor(deps.baseUrl, deps.servers),

    // Пароль есть только у сотрудников. Саморегистрация закрыта.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },

    user: {
      additionalFields: {
        claimedEmail: { type: 'string', required: false, input: false },
        onboardedAt: { type: 'date', required: false, input: false },
        lastOrgId: { type: 'string', required: false, input: false },
        locale: { type: 'string', required: false, input: false },
        policyVersion: { type: 'string', required: false, input: false },
      },
    },
    session: {
      expiresIn: SESSION_TTL_SEC,
      updateAge: SESSION_UPDATE_AGE_SEC,
      // Активную организацию меняет только сервер после проверки членства: input: false.
      additionalFields: { activeOrgId: { type: 'string', required: false, input: false } },
    },
    // Учётные записи по совпадению email не объединяются (решение 93 ТЗ).
    account: { accountLinking: { enabled: false } },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: deps.baseUrl.startsWith('https://'),
      // Идентификаторы задаёт база: uuidv7().
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    // Библиотека не считает вызовы функций, а портал вызывает её именно так. Считает портал (hdc_rate_limits).
    rateLimit: { enabled: false },
    // Ошибку возврата с сервера Smartup показывает страница входа портала, а не страница библиотеки:
    // её адрес /api/auth/error снаружи закрыт. Язык в адрес добавит прокси портала.
    onAPIError: { errorURL: `${deps.baseUrl}/login` },
    databaseHooks: { session: createSessionHooks(deps.staff) },
    hooks: { before: beforeHook },

    plugins: [
      twoFactor({
        issuer: 'Smartup Hub',
        accountLockout: { enabled: true, maxFailedAttempts: TOTP_MAX_FAILED_ATTEMPTS, durationSeconds: TOTP_LOCK_SEC },
      }),
      magicLink({
        expiresIn: LOGIN_LINK_TTL_SEC,
        // Ссылка не создаёт пользователей.
        disableSignUp: true,
        storeToken: 'hashed',
        sendMagicLink: (data) => deps.sendMagicLink(data),
      }),
      sso({
        // Серверы приходят из реестра портала, а не из таблицы библиотеки. Регистрация через библиотеку закрыта.
        defaultSSO: toSsoProviders(deps.servers),
        providersLimit: 0,
        resolveUser: (input, context) => deps.resolveUser(input, context),
        provisionUser: (data) => deps.provisionUser(data),
        provisionUserOnEveryLogin: true,
      }),
      hubTrusted(),
    ],
  } satisfies BetterAuthOptions;
}
