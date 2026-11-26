import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cookieValue } from '@/lib/cookies';

// "Войти заново" через Smartup (ASVS 7.5; проверка подготовки M9, I1). Начало входа ставит куку с временем начала и
// просит у сервера новый вход (prompt=login, max_age=0). Возврат с сервера читает куку, и проверка пользователя
// (auth/smartup.ts) отклоняет id_token, у которого auth_time раньше начала: сервер не выполнил требование и выдал
// вход по открытой сессии Smartup Web. Без auth_time проверить нельзя: вход проходит, событие пишется в журнал.

const NAME = 'hub_reauth';
/** Столько ждём возврата с сервера Smartup: кука живёт 10 минут. */
const MAX_AGE_SEC = 10 * 60;
/** Расхождение часов портала и сервера Smartup. */
export const REAUTH_CLOCK_SKEW_SEC = 60;

const names = [`__Host-${NAME}`, NAME] as const;

export function reauthCookie(https: boolean, startedSec: number): string {
  return `${https ? names[0] : names[1]}=${startedSec}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
}

export function clearReauthCookie(https: boolean): string {
  return `${https ? names[0] : names[1]}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
}

/** Время начала входа заново из куки запроса, секунды. Нет куки или значение неверно: null. */
export function reauthStartedSec(cookieHeader: string | null): number | null {
  for (const name of names) {
    const value = cookieValue(cookieHeader, name);
    if (value !== undefined) return /^\d{9,11}$/.test(value) ? Number(value) : null;
  }
  return null;
}

const store = new AsyncLocalStorage<{ startedSec: number }>();

/** Выполняет обработку возврата с сервера, зная, что это вход заново, начатый в startedSec. */
export function withReauth<T>(startedSec: number | null, run: () => Promise<T>): Promise<T> {
  return startedSec === null ? run() : store.run({ startedSec }, run);
}

/** Начало входа заново для текущего возврата с сервера или null, если это обычный вход. */
export function currentReauth(): { startedSec: number } | null {
  return store.getStore() ?? null;
}
