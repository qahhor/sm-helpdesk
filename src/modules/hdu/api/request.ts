import 'server-only';
import { isLocale, type Locale } from '@/i18n/locales';
import { getAuth } from '../auth/instance';
import { revokeSessionById } from '../core/sessions';
import { CLIENT_SESSION_MAX_SEC } from '../pref';

// Запрос глазами модуля идентичности: заголовки и место, куда положить куки ответа.
// Серверное действие получает его от nextRequest() (api/next-request.ts), тест собирает сам.

export type RequestInfo = {
  /** Заголовки входящего запроса: куки, адрес посетителя, строка браузера. */
  headers: Headers;
  /**
   * Переносит куки из ответа библиотеки входа в ответ портала. Библиотека вызывается как функция
   * и возвращает заголовки вместе с результатом: записать их в ответ должен портал (решение 0012).
   */
  setCookies(responseHeaders: Headers): void;
};

/** Сессия и пользователь, как их отдаёт библиотека входа, с колонками портала. */
export type SessionData = {
  session: {
    id: string;
    token: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    activeOrgId: string | null;
    /** Когда в этой сессии предъявлен код второго фактора. Пусто у сессии одного пароля. */
    secondFactorAt: Date | null;
    ipAddress: string | null;
    userAgent: string | null;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    claimedEmail: string | null;
    onboardedAt: Date | null;
    lastOrgId: string | null;
    /** Язык писем и сообщений бота (решение 0018). */
    locale: Locale | null;
    /** Версия политики обработки данных, с которой человек ознакомлен (задача 21). */
    policyVersion: string | null;
  };
};

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/**
 * Сессия по кукам запроса. Проверяет её библиотека входа по базе: отозванная или истёкшая сессия даёт null.
 * Сессия старше 90 суток от входа не действует и отзывается, даже если срок в базе дальше (ASVS 7.3.2):
 * так предел держится и для сессий, продлённых до этого правила. Сотрудника раньше остановит предел 12 часов.
 * Ни одно поле результата не берётся из тела запроса или адреса.
 */
export async function readSession(request: Pick<RequestInfo, 'headers'>): Promise<SessionData | null> {
  const auth = await getAuth();
  const data = await auth.api.getSession({ headers: request.headers });
  if (!data) return null;
  const { session, user } = data;
  if (Date.now() - toDate(session.createdAt).getTime() > CLIENT_SESSION_MAX_SEC * 1000) {
    await revokeSessionById(session.id);
    return null;
  }
  return {
    session: {
      id: session.id,
      token: session.token,
      userId: session.userId,
      createdAt: toDate(session.createdAt),
      expiresAt: toDate(session.expiresAt),
      activeOrgId: session.activeOrgId ?? null,
      secondFactorAt: session.secondFactorAt ? toDate(session.secondFactorAt) : null,
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled === true,
      claimedEmail: user.claimedEmail ?? null,
      onboardedAt: user.onboardedAt ? toDate(user.onboardedAt) : null,
      lastOrgId: user.lastOrgId ?? null,
      locale: typeof user.locale === 'string' && isLocale(user.locale) ? user.locale : null,
      policyVersion: user.policyVersion ?? null,
    },
  };
}
