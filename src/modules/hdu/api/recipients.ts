import 'server-only';
import * as z from 'zod';
import { adminIdsTx, lineLeadsTx, type MailRecipient, mailRecipientTx, markTelegramBlockedTx, organizationNameTx, replyRolesTx, replyRoleTx, telegramChatTx, telegramLinkedManyTx } from '../core/recipients';
import type { Locale } from '@/i18n/locales';

// Модуль hdu, слой api: адрес для письма пользователю (решение 2 вехи M4), руководители линии, администраторы
// и название организации для уведомлений (решения 7 и 8). Узкий файл: его берёт фоновый
// процесс, в сборку которого не должны попадать страницы.

export type { MailRecipient };

export async function mailRecipient(userId: string): Promise<MailRecipient | null> {
  const id = z.uuid().safeParse(userId);
  return id.success ? mailRecipientTx(id.data) : null;
}

export function lineLeads(line: 'l1' | 'l2'): Promise<string[]> {
  return lineLeadsTx(line);
}

export function adminIds(): Promise<string[]> {
  return adminIdsTx();
}

export async function organizationName(orgId: string): Promise<string | null> {
  const id = z.uuid().safeParse(orgId);
  return id.success ? organizationNameTx(id.data) : null;
}

/** Роль пользователя для ответа из письма в обращение этой организации или null (решение 16 вехи M4). */
export async function replyRole(userId: string, orgId: string): Promise<'client_user' | 'client_admin' | null> {
  const user = z.uuid().safeParse(userId);
  const org = z.uuid().safeParse(orgId);
  return user.success && org.success ? replyRoleTx(user.data, org.data) : null;
}

/** Чат Telegram для уведомления (план M4b): действующая привязка без блокировки бота или null. */
export async function telegramChat(userId: string): Promise<{ chatId: string; locale: Locale | null } | null> {
  const id = z.uuid().safeParse(userId);
  return id.success ? telegramChatTx(id.data) : null;
}

/** Привязан ли Telegram и не заблокирован ли бот. */
export async function telegramLinked(userId: string): Promise<boolean> {
  return (await telegramChat(userId)) !== null;
}

/** Telegram ответил 403 на сообщение в этот чат: бот заблокирован, уведомления в Telegram прекращаются. */
export async function markTelegramBlocked(chatId: string): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId)) return;
  await markTelegramBlockedTx(chatId);
}

const uuids = z.array(z.uuid()).max(500);

/** Роли пользователей в организации одним запросом: для уведомлений многим получателям. */
export async function replyRoles(userIds: string[], orgId: string): Promise<Map<string, 'client_user' | 'client_admin'>> {
  const users = uuids.safeParse(userIds);
  const org = z.uuid().safeParse(orgId);
  return users.success && org.success ? replyRolesTx(users.data, org.data) : new Map();
}

/** У кого из пользователей действует привязка Telegram: одним запросом. */
export async function telegramLinkedMany(userIds: string[]): Promise<Set<string>> {
  const users = uuids.safeParse(userIds);
  return users.success ? telegramLinkedManyTx(users.data) : new Set();
}
