import 'server-only';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { clientIp } from '@/modules/hdc/api';
import { type ClientSignInMethod, noteClientSignIn, TRUSTED_SIGN_IN_WAYS } from '../core/sign-in-audit';
import { CLIENT_SESSION_MAX_SEC, STAFF_SESSION_TTL_SEC } from '../pref';
import type { StaffInfo } from '../core/staff';
import { currentReauth } from './reauth';

// Перехватчики библиотеки входа. Они срабатывают и при вызове библиотеки как функции (решение 0012).
//
// Библиотека не обеспечивает сама три правила ТЗ, их держат эти перехватчики:
//   1. сотрудник входит только по паролю с кодом второго фактора (FR-ID-09);
//   2. сессия сотрудника живёт 12 часов и не продлевается (FR-ID-10), сессия клиента продлевается
//      при активности, но не дальше 90 суток от входа (ASVS 7.3.2, решение 0067);
//   3. "доверенное устройство" обходит второй фактор и поэтому запрещено;
//   4. время проверки личности (freshAuthAt) ставится только при создании сессии и только тем входом, где человек
//      подтвердил личность: от него считается недавний вход (решение 0083).

export type StaffLookup = (userId: string) => Promise<StaffInfo | null>;

/** Пути, которыми сессию может получить сотрудник: пароль и код второго фактора. */
const STAFF_SIGN_IN_PATHS = new Set(['/sign-in/email', '/two-factor/verify-totp']);
const PASSWORD_PATH = '/sign-in/email';
/** Путь проверки кода: только сессия, созданная здесь, получает отметку второго фактора. */
const TOTP_PATH = '/two-factor/verify-totp';

type SessionDraft = { userId: string; expiresAt?: Date | string } & Record<string, unknown>;
type HookContext = {
  path?: string;
  headers?: Headers;
  body?: unknown;
  context?: { session?: { session?: { createdAt?: Date | string }; user?: { id?: string } } | null };
} | null;

export type SignInNote = (userId: string, method: ClientSignInMethod, ip: string | null) => Promise<void>;

/** Способ входа клиента по пути точки входа библиотеки. Свой способ (sign-in/trusted) называет его сам в теле запроса. */
function clientMethod(ctx: HookContext): ClientSignInMethod {
  const path = ctx?.path ?? '';
  if (path.startsWith('/sso/')) return 'smartup';
  if (path.startsWith('/magic-link/')) return 'email_link';
  const via = (ctx?.body as { via?: unknown } | undefined)?.via;
  if (path === '/sign-in/trusted' && TRUSTED_SIGN_IN_WAYS.some((way) => way === via)) return via as ClientSignInMethod;
  return 'other';
}

/** Возврат с сервера Smartup после "Войти заново" (prompt=login, max_age=0), прошедший проверку auth_time (api/sso.ts). */
export type ReauthCheck = () => boolean;
const reauthInProgress: ReauthCheck = () => currentReauth() !== null;

/**
 * Подтвердил ли человек личность этим входом клиента. Ссылка из письма, приглашение и ссылка из бота доказывают
 * владение почтой или Telegram прямо сейчас. Вход через Smartup считается, только если это вход заново: обычный
 * мог пройти по открытой сессии Smartup Web без пароля. Вход заново с устаревшим auth_time сюда не доходит:
 * проверка пользователя (api/sso.ts) его отклоняет до создания сессии.
 */
function clientAuthenticated(method: ClientSignInMethod, reauth: ReauthCheck): boolean {
  if (method === 'smartup') return reauth();
  return method !== 'other';
}

export function createSessionHooks(findStaff: StaffLookup, noteSignIn: SignInNote = noteClientSignIn, reauth: ReauthCheck = reauthInProgress) {
  return {
    create: {
      /**
       * Вход клиента пишется в журнал аудита (аудит 23.11.2026, находка S8): кто, каким способом, с какого адреса.
       * Вход сотрудника пишет staff.signed_in после кода второго фактора (api/staff.ts). Сбой записи вход не отменяет:
       * сессия уже создана, об ошибке говорит журнал процесса.
       */
      async after(session: SessionDraft, ctx: HookContext) {
        try {
          if (await findStaff(session.userId)) return;
          await noteSignIn(session.userId, clientMethod(ctx), ctx?.headers ? clientIp(ctx.headers) : null);
        } catch (error) {
          console.error('Журнал аудита: вход клиента не записан', error instanceof Error ? error.message : '');
        }
      },
      /** Кто и каким путём может получить сессию. Возврат false отменяет создание сессии. */
      async before(session: SessionDraft, ctx: HookContext) {
        const path = ctx?.path ?? '';
        const staff = await findStaff(session.userId);
        if (!staff) {
          // Пароль есть только у сотрудников. Клиент с паролем это ошибка в данных: не пускаем.
          if (path === PASSWORD_PATH) return false;
          // Библиотека добавляет поля результата к своим данным сессии.
          return { data: { freshAuthAt: clientAuthenticated(clientMethod(ctx), reauth) ? new Date() : null } };
        }
        if (staff.state !== 'active' || staff.role === 'agent_bot') return false;
        if (!STAFF_SIGN_IN_PATHS.has(path)) return false;
        // Сессия после одного пароля нужна только для подключения второго фактора: отметки у неё нет,
        // и рабочее место она не откроет, даже если второй фактор потом подключат в другом браузере.
        // Пароль (с кодом) это проверка личности: от неё считается свежий вход для настроек (решение 0083).
        const now = new Date();
        return {
          data: {
            ...session,
            expiresAt: new Date(now.getTime() + STAFF_SESSION_TTL_SEC * 1000),
            secondFactorAt: path === TOTP_PATH ? now : null,
            freshAuthAt: now,
          },
        };
      },
    },
    update: {
      /**
       * Библиотека продлевает сессию при активности. Сессию сотрудника продлить дальше 12 часов от входа нельзя,
       * сессию клиента дальше 90 суток от входа. Время проверки личности продление не трогает: его пишет только
       * создание сессии, снаружи поле не задать (input: false в auth/options.ts).
       */
      async before(data: Record<string, unknown>, ctx: HookContext) {
        if (!('expiresAt' in data) || data.expiresAt == null) return undefined;
        const current = ctx?.context?.session;
        const userId = current?.user?.id;
        const createdAt = current?.session?.createdAt;
        if (!userId || !createdAt) return undefined;
        const ttl = (await findStaff(userId)) ? STAFF_SESSION_TTL_SEC : CLIENT_SESSION_MAX_SEC;
        const limit = new Date(createdAt).getTime() + ttl * 1000;
        const wanted = new Date(data.expiresAt as Date | string).getTime();
        return { data: { ...data, expiresAt: new Date(Math.min(limit, wanted)) } };
      },
    },
  };
}

/** Поля токенов сервера Smartup в auth.account. */
const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'] as const;

function withoutTokens(account: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...account };
  for (const field of TOKEN_FIELDS) if (field in copy) copy[field] = null;
  return copy;
}

/**
 * Токены сервера Smartup портал не использует: личность берётся при входе, дальше работает сессия портала.
 * Поэтому в базу они не пишутся, и утечка резервной копии не отдаёт действующие токены клиентов
 * (итоговая проверка вехи M1, решение 0012).
 */
export const accountHooks = {
  create: {
    async before(account: Record<string, unknown>) {
      return { data: withoutTokens(account) };
    },
  },
  update: {
    async before(account: Record<string, unknown>) {
      return { data: withoutTokens(account) };
    },
  },
};

/** Запрос "запомнить это устройство" при проверке кода отклоняется: настройкой его не выключить. */
export const beforeHook = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as { trustDevice?: unknown } | undefined;
  if (ctx.path?.startsWith('/two-factor/verify-') && body?.trustDevice)
    throw new APIError('FORBIDDEN', { code: 'TRUST_DEVICE_DISABLED', message: 'Trusted devices are disabled' });
});
