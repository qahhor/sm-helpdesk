import 'server-only';
import * as z from 'zod';
import { type SystemActor, withActor } from '@/db/with-actor';
import {
  cleanupNotificationsTx,
  type ClientPrefs,
  listNotificationsTx,
  markReadTx,
  notifyTx,
  type NotificationRow,
  openNotificationTx,
  type PersonActor,
  readPrefsTx,
  savePrefsTx,
  type StaffPrefs,
  unreadCountTx,
} from '../core/notifications';

// Модуль hdn, слой api: уведомления в портале и каналы уведомлений (FR-NT-03, FR-NT-04, FR-NT-14; решение 5 вехи M4,
// решения 3 и 4 вехи M4b).
// Актор только из проверенной сессии: страницы передают его из requireClientActor и requireStaffActor.

export { type Channels, channelsFor, channelsForMany, emailAllowed, notifyTx, type NotificationRow, type PersonActor } from '../core/notifications';
export { type NotificationKind, type PrefKind } from '../schema';
export type { ClientPrefs, StaffPrefs };
export { isHdnError } from '../error';

const ids = z.array(z.uuid()).max(100);

export async function unreadCount(actor: PersonActor): Promise<number> {
  return unreadCountTx(actor);
}

export async function listNotifications(actor: PersonActor, input: { before?: string }): Promise<NotificationRow[]> {
  const before = input.before ? z.iso.datetime().parse(input.before) : null;
  return listNotificationsTx(actor, before ? new Date(before) : null);
}

export async function markRead(actor: PersonActor, input: string[] | 'all'): Promise<void> {
  await markReadTx(actor, input === 'all' ? 'all' : ids.parse(input));
}

export async function openNotification(actor: PersonActor, id: unknown): Promise<NotificationRow | null> {
  const parsed = z.uuid().safeParse(id);
  return parsed.success ? openNotificationTx(actor, parsed.data) : null;
}

export async function savePrefs(actor: PersonActor, input: unknown): Promise<void> {
  await savePrefsTx(actor, input);
}

export async function readPrefs(actor: PersonActor): Promise<ClientPrefs | StaffPrefs> {
  return readPrefsTx(actor);
}

export async function cleanupNotifications(actor: SystemActor, now: Date): Promise<number> {
  return cleanupNotificationsTx(actor, now);
}

/** Уведомление в портале о новой привязке Telegram (FR-NT-13, решение 6 вехи M4b): рядом с письмом о привязке. */
export async function notifyTelegramLinked(userId: string): Promise<void> {
  const id = z.uuid().parse(userId);
  await withActor({ type: 'system', job: 'identity.telegram' }, (tx) => notifyTx(tx, { userId: id, kind: 'telegram_linked', payload: {} }));
}
