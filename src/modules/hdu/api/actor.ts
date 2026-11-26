import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';
import type { Locale } from '@/i18n/locales';
import { clientIp } from '@/modules/hdc/api';
import { getAuth } from '../auth/instance';
import { findStaff } from '../core/staff';
import type { StaffRole } from '../pref';
import { policyNoticeUrl, safeReturnPath } from '../util';
import { acknowledgePolicy, confirmEmail } from './email';
import { type ClientContext, type ClientDenial, resolveClient, switchOrganization } from './orgs';
import { listMySessions, revokeMySession, revokeOtherSessions, type SessionView } from './sessions';
import { rememberLocale } from './telegram';
import { readSession, type RequestInfo, type SessionData } from './request';
import { resolveStaff, type StaffContext, type StaffDenial, staffAccess } from './session';

// Вход в защищённые разделы: проверка сессии и роли на каждом запросе (ТЗ 9.4, правило 7).
// Раскладка и страница вызывают эти функции каждая сама: одинаковые проверки в пределах одного запроса
// объединяет память запроса (cache из React, решение 0014). Между запросами она не живёт.

/** Путь текущего запроса. Его ставит прокси портала, значение от клиента затирается. */
async function currentPath(): Promise<string> {
  return (await headers()).get('x-hub-path') ?? '';
}

/** Шаг о новой редакции политики с возвратом на текущую страницу (итоговая проверка M1). */
export async function policyNoticePath(): Promise<string> {
  return policyNoticeUrl(await getLocale(), await currentPath());
}

/** Сессия текущего запроса. Проверяет её библиотека входа по базе, один раз на запрос. */
const sessionOfRequest = cache(async (): Promise<SessionData | null> => readSession({ headers: new Headers(await headers()) }));

/** Проверенный адрес посетителя: актор несёт его в транзакцию, база ставит его в журнал аудита (S5). */
async function requestIp(): Promise<string | null> {
  return clientIp(new Headers(await headers()));
}

const staffOfRequest = cache(async (): Promise<StaffContext | StaffDenial> => {
  const result = await resolveStaff(await sessionOfRequest(), new Date());
  return 'denied' in result ? result : { ...result, actor: { ...result.actor, ip: await requestIp() } };
});

const clientOfRequest = cache(async (): Promise<ClientContext | ClientDenial> => {
  const result = await resolveClient(await sessionOfRequest());
  return 'denied' in result ? result : { ...result, actor: { ...result.actor, ip: await requestIp() } };
});

/**
 * Сотрудник текущего запроса. Без входа, без второго фактора и после 12 часов перенаправляет
 * на страницу входа сотрудников с возвратом на текущую страницу. Не сотруднику и сотруднику
 * без нужной роли отвечает 404: рабочее место не раскрывает, что такой раздел есть.
 */
export async function requireStaffActor(opts: { roles?: readonly StaffRole[] } = {}): Promise<StaffContext> {
  const result = await staffOfRequest();
  const access = staffAccess(result, opts.roles, (await sessionOfRequest())?.user.id);
  if (access === 'not_found') notFound();
  if ('denied' in result) {
    const locale = await getLocale();
    const next = safeReturnPath(await currentPath(), `/${locale}/agent`);
    redirect(`/${locale}/staff/login?next=${encodeURIComponent(next)}`);
  }
  return result;
}

/** Сотрудник текущего запроса, если он вошёл полностью. Для страниц входа: вошедшего туда не пускаем повторно. */
export async function currentStaff(): Promise<StaffContext | null> {
  const result = await staffOfRequest();
  return 'denied' in result ? null : result;
}

/** Завершает сессию этого браузера и убирает её куки. */
export async function signOut(request: RequestInfo): Promise<void> {
  const auth = await getAuth();
  try {
    const result = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
    request.setCookies(result.headers);
  } catch {
    // Сессии уже нет: выходить не из чего.
  }
}

/**
 * Кто вошёл в этом браузере, без проверки прав: для страниц входа, чтобы вошедшего отправить дальше.
 * Сотрудник с незавершённым вторым фактором тоже считается сотрудником.
 */
export const signedInKind = cache(async (): Promise<'staff' | 'client' | null> => {
  const session = await sessionOfRequest();
  if (!session) return null;
  return (await findStaff(session.user.id)) ? 'staff' : 'client';
});

/**
 * Клиент текущего запроса с активной организацией. Каждая страница кабинета вызывает эту функцию сама:
 * отключённый участник теряет доступ на следующем запросе. Без входа ведёт на страницу входа с возвратом,
 * сотрудника в рабочее место, без организации на экран "нет организации", при нескольких на выбор.
 */
export async function requireClientActor(): Promise<ClientContext> {
  const result = await clientOfRequest();
  if (!('denied' in result)) return result;
  const locale = await getLocale();
  const next = encodeURIComponent(safeReturnPath(await currentPath(), `/${locale}`));
  switch (result.denied) {
    case 'no_session':
      redirect(`/${locale}/login?next=${next}`);
    case 'staff':
      redirect(`/${locale}/agent`);
    case 'no_organization':
      redirect(`/${locale}/no-organization`);
    case 'choose_organization':
      redirect(`/${locale}/select-organization?next=${next}`);
  }
}

/**
 * Клиент текущего запроса с организацией для обработчиков /api/: без перенаправлений. Нет входа, сотрудник,
 * нет или не выбрана организация: null, обработчик отвечает 401.
 */
export async function currentClient(): Promise<ClientContext | null> {
  const result = await clientOfRequest();
  return 'denied' in result ? null : result;
}

/**
 * Вошедший клиент без требования организации: для экранов выбора организации и "нет организации".
 * Без входа ведёт на страницу входа, сотрудника в рабочее место.
 */
export async function requireSignedInClient(): Promise<{ userId: string; name: string }> {
  const session = await sessionOfRequest();
  const locale = await getLocale();
  if (!session) redirect(`/${locale}/login`);
  if (await findStaff(session.user.id)) redirect(`/${locale}/agent`);
  return { userId: session.user.id, name: session.user.name };
}

/**
 * Переключение организации из серверного действия. Сессия берётся из кук запроса,
 * идентификатор организации из формы проверяет switchOrganization: чужая организация даёт not_member.
 */
export async function switchOrganizationOfRequest(orgId: unknown): Promise<void> {
  // Сессия читается мимо памяти запроса: страница, на которую ведёт действие, отрисовывается в том же запросе
  // и должна увидеть сессию уже после переключения, а не снимок, сделанный до него.
  const session = await readSession({ headers: new Headers(await headers()) });
  if (!session) redirect(`/${await getLocale()}/login`);
  await switchOrganization(session, orgId);
}

/** Сессии вошедшего пользователя для страниц "Профиль" и "Сессии". Без входа: пустой список. */
export async function mySessions(): Promise<{ items: SessionView[]; hidden: number }> {
  const session = await sessionOfRequest();
  return session ? listMySessions(session) : { items: [], hidden: 0 };
}

/** Завершение всех своих сессий, кроме текущей, из серверного действия. */
export async function revokeOtherSessionsOfRequest(): Promise<{ revoked: number }> {
  const session = await readSession({ headers: new Headers(await headers()) });
  return session ? revokeOtherSessions(session, await requestIp()) : { revoked: 0 };
}

/**
 * Завершение своей сессии из серверного действия. Сессия читается мимо памяти запроса:
 * страница после действия должна увидеть список уже без завершённой сессии.
 */
export async function revokeMySessionOfRequest(sessionId: unknown): Promise<{ signedOut: boolean }> {
  const session = await readSession({ headers: new Headers(await headers()) });
  if (!session) return { signedOut: true };
  return revokeMySession(session, sessionId, await requestIp());
}

/** Имя вошедшего клиента для страниц без входа (подтверждение адреса). Пусто, если клиента нет. */
export async function currentClientName(): Promise<string | null> {
  const session = await sessionOfRequest();
  if (!session) return null;
  const kind = await signedInKind();
  return kind === 'client' ? session.user.name : null;
}

/** Имя учётной записи, в которую вошли в этом браузере, клиента или сотрудника. Без входа: пусто. */
export async function signedInName(): Promise<string | null> {
  return (await sessionOfRequest())?.user.name ?? null;
}

/** Согласие с редакцией политики с адресом этого запроса в журнале (итоговая проверка доработки). */
export async function acknowledgePolicyOfRequest(userId: string, version: string): Promise<void> {
  await acknowledgePolicy(userId, version, await requestIp());
}

/** Подтверждение адреса по ссылке от имени сессии этого запроса (проверка main, S2). */
export async function confirmEmailOfRequest(input: unknown): ReturnType<typeof confirmEmail> {
  const requestHeaders = new Headers(await headers());
  return confirmEmail(input, await readSession({ headers: requestHeaders }), clientIp(requestHeaders));
}

/** Вошедший пользователь выбрал язык в портале: письма и бот пойдут на нём (решение 0018, пункт 19). */
export async function rememberMyLocale(locale: Locale): Promise<void> {
  const session = await sessionOfRequest();
  if (session) await rememberLocale(session.user.id, locale);
}
