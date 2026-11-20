import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';
import { getAuth } from '../auth/instance';
import { findStaff } from '../core/staff';
import type { StaffRole } from '../pref';
import { safeReturnPath } from '../util';
import { readSession, type RequestInfo } from './request';
import { FRESH_SIGN_IN_SEC, isFresh, resolveStaff, type StaffContext, type StaffDenial } from './session';

// Вход в защищённые разделы: проверка сессии и роли на каждом запросе (ТЗ 9.4, правило 7).
// Раскладка и страница вызывают эти функции каждая сама: одинаковые проверки в пределах одного запроса
// объединяет память запроса (cache из React, решение 0014). Между запросами она не живёт.

/** Путь текущего запроса. Его ставит прокси портала, значение от клиента затирается. */
async function currentPath(): Promise<string> {
  return (await headers()).get('x-hub-path') ?? '';
}

const staffOfRequest = cache(async (): Promise<StaffContext | StaffDenial> => {
  const session = await readSession({ headers: new Headers(await headers()) });
  return resolveStaff(session, new Date());
});

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
  const session = await readSession({ headers: new Headers(await headers()) });
  if (!session) return null;
  return (await findStaff(session.user.id)) ? 'staff' : 'client';
});
