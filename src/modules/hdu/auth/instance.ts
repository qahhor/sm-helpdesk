import 'server-only';
import { betterAuth } from 'better-auth';
import { getAuthPool } from '@/db/auth-client';
import { env } from '@/env';
import { listSsoServers, registryStamp } from '../core/servers';
import { findStaff } from '../core/staff';
import { sendLoginLinkMail } from './mail';
import { type AuthDeps, buildAuthOptions } from './options';
import { provisionForLibrary, resolveUserForLibrary } from './smartup';

// Экземпляр библиотеки входа: один на процесс, создаётся при первом обращении.
// Серверы Smartup библиотека получает настройкой, поэтому при изменении реестра экземпляр создаётся заново.

const createAuth = (deps: AuthDeps) => betterAuth(buildAuthOptions(deps));
export type Auth = ReturnType<typeof createAuth>;

/** Части настроек, которые подключают другие файлы модуля: письма и вход через Smartup. */
export type AuthHandlers = Pick<AuthDeps, 'sendMagicLink' | 'resolveUser' | 'provisionUser'>;

// Письмо со ссылкой для входа и вход через Smartup.
const DEFAULT_HANDLERS: AuthHandlers = {
  sendMagicLink: sendLoginLinkMail,
  resolveUser: resolveUserForLibrary,
  provisionUser: provisionForLibrary,
};

const REGISTRY_CHECK_MS = 15_000;

type State = { auth: Auth; stamp: string; checkedAt: number };
const shared = globalThis as typeof globalThis & {
  __hubAuth?: State;
  __hubAuthBuilding?: Promise<State>;
};

async function build(stamp: string): Promise<State> {
  const auth = createAuth({
    pool: getAuthPool(),
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.HUB_URL,
    servers: await listSsoServers(),
    staff: findStaff,
    ...DEFAULT_HANDLERS,
  });
  return { auth, stamp, checkedAt: Date.now() };
}

/**
 * Экземпляр библиотеки входа. Не чаще раза в 15 секунд сверяется состояние реестра серверов:
 * добавленный сервер начинает принимать вход без перезапуска, отключённый перестаёт.
 * refresh: true сверяет сразу (нужно в начале входа через сервер).
 */
export async function getAuth(opts: { refresh?: boolean } = {}): Promise<Auth> {
  const current = shared.__hubAuth;
  if (current && !opts.refresh && Date.now() - current.checkedAt < REGISTRY_CHECK_MS) return current.auth;
  const stamp = await registryStamp();
  if (current && current.stamp === stamp) {
    current.checkedAt = Date.now();
    return current.auth;
  }
  // Одновременные запросы ждут одну сборку, а не создают несколько экземпляров.
  shared.__hubAuthBuilding ??= build(stamp).finally(() => {
    shared.__hubAuthBuilding = undefined;
  });
  shared.__hubAuth = await shared.__hubAuthBuilding;
  return shared.__hubAuth.auth;
}

/** Забывает экземпляр. Нужна тестам. */
export function resetAuth(): void {
  shared.__hubAuth = undefined;
  shared.__hubAuthBuilding = undefined;
}
