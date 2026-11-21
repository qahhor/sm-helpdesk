import 'server-only';
import { listUserSessions, revokeOtherOwnSessions, revokeOwnSession } from '../core/sessions';
import { HduError } from '../error';
import { parseInput, uuidInput } from '../input';
import { type DeviceInfo, describeUserAgent } from '../util';
import type { SessionData } from './request';

// Сессии пользователя: где выполнен вход и завершение на другом устройстве (ТЗ 14.3).
// Токен сессии не покидает сервер: в браузер уходит только идентификатор строки.

export type SessionView = DeviceInfo & {
  sessionId: string;
  ip: string | null;
  createdOn: Date;
  lastSeenOn: Date;
  isCurrent: boolean;
};

/** Сколько сессий показывается в списке. Остальные завершаются кнопкой "Завершить все другие сессии". */
export const SESSION_LIST_LIMIT = 20;

/** Неистёкшие сессии самого пользователя: текущая первой, затем недавние. hidden: сколько не показано. */
export async function listMySessions(session: SessionData): Promise<{ items: SessionView[]; hidden: number }> {
  const rows = await listUserSessions(session.user.id);
  const views = rows.map((row) => ({
    sessionId: row.id,
    ...describeUserAgent(row.userAgent),
    ip: row.ipAddress,
    createdOn: row.createdAt,
    lastSeenOn: row.updatedAt,
    isCurrent: row.id === session.session.id,
  }));
  const ordered = [...views.filter((view) => view.isCurrent), ...views.filter((view) => !view.isCurrent)];
  return { items: ordered.slice(0, SESSION_LIST_LIMIT), hidden: Math.max(0, ordered.length - SESSION_LIST_LIMIT) };
}

/** Завершает все свои сессии, кроме текущей: например, когда потерян телефон. */
export async function revokeOtherSessions(session: SessionData, ip?: string | null): Promise<{ revoked: number }> {
  return { revoked: await revokeOtherOwnSessions(session.user.id, session.session.id, ip) };
}

/** Завершает свою сессию. Чужая и несуществующая дают одно и то же: not_found. Текущая: это выход. */
export async function revokeMySession(session: SessionData, sessionId: unknown, ip?: string | null): Promise<{ signedOut: boolean }> {
  const id = parseInput(uuidInput, sessionId);
  if (!(await revokeOwnSession(session.user.id, id, ip))) throw new HduError('not_found');
  return { signedOut: id === session.session.id };
}
