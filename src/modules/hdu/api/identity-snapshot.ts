import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as z from 'zod';
import { organizationNameTx, replyRolesTx, telegramLinkedManyTx } from '../core/recipients';

// Модуль hdu, слой api: сведения о получателях уведомления, прочитанные до транзакции записи (проверка качества, Q2).
//
// Транзакция записи обращения идёт под ролью hub_app. Уведомление внутри неё спрашивало роли получателей, привязку
// Telegram и название организации у таблиц идентичности, то есть открывало вторую транзакцию на пуле hub_auth: первая
// держала соединение и блокировки строк, пока вторая ждала свободное соединение. Теперь вызывающий читает эти
// сведения до своей транзакции и выполняет её внутри withIdentitySnapshot. Функции чтения (replyRoles,
// telegramLinkedMany, organizationName) сначала смотрят в снимок и идут в базу только за тем, чего в нём нет.
//
// Это не кеш: снимок живёт одну операцию, читается прямо перед транзакцией и никому больше не виден. Окно между
// чтением и записью то же, что и раньше между запросом ролей и вставкой уведомления.

export type IdentitySnapshot = {
  orgId: string;
  /** О ком снимок знает ответ: кого здесь нет, того читает база. */
  userIds: ReadonlySet<string>;
  roles: ReadonlyMap<string, 'client_user' | 'client_admin'>;
  telegramLinked: ReadonlySet<string>;
  orgName: string | null;
};

const store = new AsyncLocalStorage<readonly IdentitySnapshot[]>();

/** Читает снимок: роли пользователей в организации, привязки Telegram и название организации. Вне транзакции. */
export async function readIdentitySnapshot(orgId: string, userIds: readonly string[]): Promise<IdentitySnapshot | null> {
  if (!z.uuid().safeParse(orgId).success) return null;
  const ids = [...new Set(userIds.filter((id) => z.uuid().safeParse(id).success))].slice(0, 500);
  const [roles, telegramLinked, orgName] = await Promise.all([replyRolesTx(ids, orgId), telegramLinkedManyTx(ids), organizationNameTx(orgId)]);
  return { orgId, userIds: new Set(ids), roles, telegramLinked, orgName };
}

/** Выполняет операцию со снимками: чтения внутри неё берут ответ из снимка. Пустые снимки пропускаются. */
export function withIdentitySnapshot<T>(snapshots: readonly (IdentitySnapshot | null)[], fn: () => Promise<T>): Promise<T> {
  const list = snapshots.filter((s): s is IdentitySnapshot => s !== null);
  return list.length === 0 ? fn() : store.run([...(store.getStore() ?? []), ...list], fn);
}

const current = (): readonly IdentitySnapshot[] => store.getStore() ?? [];

/** Роли из снимка, если он знает всех спрошенных пользователей этой организации. Иначе null: читать базу. */
export function snapshotRoles(userIds: readonly string[], orgId: string): Map<string, 'client_user' | 'client_admin'> | null {
  const snapshot = current().find((s) => s.orgId === orgId && userIds.every((id) => s.userIds.has(id)));
  if (!snapshot) return null;
  return new Map(userIds.flatMap((id) => (snapshot.roles.has(id) ? [[id, snapshot.roles.get(id)!] as const] : [])));
}

/** Привязки Telegram из снимков, если они знают всех спрошенных. Иначе null. */
export function snapshotTelegramLinked(userIds: readonly string[]): Set<string> | null {
  const snapshots = current();
  if (snapshots.length === 0) return null;
  const linked = new Set<string>();
  for (const id of userIds) {
    const snapshot = snapshots.find((s) => s.userIds.has(id));
    if (!snapshot) return null;
    if (snapshot.telegramLinked.has(id)) linked.add(id);
  }
  return linked;
}

/** Название организации из снимка. undefined: снимка этой организации нет, читать базу. */
export function snapshotOrgName(orgId: string): string | null | undefined {
  const snapshot = current().find((s) => s.orgId === orgId);
  return snapshot ? snapshot.orgName : undefined;
}
