import 'server-only';
import type { Pool } from 'pg';
import { getAuthPool, isRestrictedAuthRole } from './auth-client';
import { getAppPool, isRestrictedAppRole, pingPool } from './client';

// Готовность базы: оба подключения приложения отвечают, и каждое идёт под своей ограниченной ролью.
// Сервер с неверно настроенным подключением не должен считаться готовым.

export type ReadyOptions = {
  timeoutMs?: number;
  /** Подмена пулов нужна тестам. */
  appPool?: Pool;
  authPool?: Pool;
};

export async function pingDatabases(opts: ReadyOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const [app, auth] = await Promise.all([
    pingPool(opts.appPool ?? getAppPool(), timeoutMs, isRestrictedAppRole),
    pingPool(opts.authPool ?? getAuthPool(), timeoutMs, isRestrictedAuthRole),
  ]);
  return app && auth;
}
