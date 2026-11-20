import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';
import { getAuth } from '../auth/instance';
import { findStaff } from '../core/staff';
import type { StaffRole } from '../pref';
import { safeReturnPath } from '../util';
import { type ClientContext, type ClientDenial, resolveClient, switchOrganization } from './orgs';
import { readSession, type RequestInfo, type SessionData } from './request';
import { FRESH_SIGN_IN_SEC, isFresh, resolveStaff, type StaffContext, type StaffDenial } from './session';

// Вход в защищённые разделы: проверка сессии и роли на каждом запросе (ТЗ 9.4, правило 7).
// Раскладка и страница вызывают эти функции каждая сама: одинаковые проверки в пределах одного запроса
// объединяет память запроса (cache из React, решение 0014). Между запросами она не живёт.

/** Путь текущего запроса. Его ставит прокси портала, значение от клиента затирается. */
async function currentPath(): Promise<string> {
  return (await headers()).get('x-hub-path') ?? '';
}

/** Сессия текущего запроса. Проверяет её библиотека входа по базе, один раз на запрос. */
const sessionOfRequest = cache(async (): Promise<SessionData | null> => readSession({ headers: new Headers(await headers()) }));

const staffOfRequest = cache(async (): Promise<StaffContext | StaffDenial> => resolveStaff(await sessionOfRequest(), new Date()));

const clientOfRequest = cache(async (): Promise<ClientContext | ClientDenial> => resolveClient(await sessionOfRequest()));

/**
 * Сотрудник текущего запроса. Без входа, без второго фактора и после 12 часов перенаправляет
 * на страницу входа сотрудников с возвратом на текущую страницу. Не сотруднику и сотруднику
 * без нужной роли отвечает 404: рабочее место не раскрывает, что такой раздел есть.
 */
export async function requireStaffActor(opts: { roles?: readonly StaffRole[] } = {}): Promise<StaffContext> {
  const result = await staffOfRequest();
  if ('denied' in result) {
    if (result.denied === 'not_staff') notFound();
    const locale = await getLocale();
    const next = safeReturnPath(await currentPath(), `/${locale}/agent`);
    redirect(`/${locale}/staff/login?next=${encodeURIComponent(next)}`);
  }
  if (opts.roles && !opts.roles.includes(result.actor.staffRole)) notFound();
  return result;
}

/**
 * То же, но вход должен быть свежим: не старше 15 минут (ТЗ 14.3). Иначе сотрудник входит заново
 * и возвращается на эту же страницу.
 */
export async function requireFreshStaffActor(
  opts: { roles?: readonly StaffRole[]; maxAgeSec?: number } = {},
): Promise<StaffContext> {
  const ctx = await requireStaffActor(opts);
  if (!isFresh(ctx, new Date(), opts.maxAgeSec ?? FRESH_SIGN_IN_SEC)) {
    const locale = await getLocale();
    const next = safeReturnPath(await currentPath(), `/${locale}/agent`);
    redirect(`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(next)}`);
  }
  return ctx;
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
