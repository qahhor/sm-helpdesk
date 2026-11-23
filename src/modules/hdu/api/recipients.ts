import 'server-only';
import * as z from 'zod';
import { adminIdsTx, lineLeadsTx, type MailRecipient, mailRecipientTx, organizationNameTx, replyRoleTx, telegramChatTx } from '../core/recipients';
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
