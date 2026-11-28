import 'server-only';
import * as z from 'zod';
import { adminIdsTx, staffIdsWithRoleTx, lineLeadsTx, type MailRecipient, mailAddressesTx, mailRecipientTx, markTelegramBlockedTx, organizationNameTx, replyRolesTx, replyRoleTx, telegramChatTx, telegramLinkedManyTx } from '../core/recipients';
import type { Locale } from '@/i18n/locales';
import { snapshotOrgName, snapshotRoles, snapshotTelegramLinked } from './identity-snapshot';

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

/** Действующие сотрудники с ролью product или admin (сводка модерации идей, план M7, задача 8). */
export function staffIdsWithRole(role: 'product' | 'admin'): Promise<string[]> {
  return staffIdsWithRoleTx(role);
}

export async function organizationName(orgId: string): Promise<string | null> {
  const id = z.uuid().safeParse(orgId);
  if (!id.success) return null;
  // Название, прочитанное до транзакции вызывающего (проверка качества, Q2).
  const known = snapshotOrgName(id.data);
  return known !== undefined ? known : organizationNameTx(id.data);
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

/** Адреса для писем нескольких пользователей одной транзакцией на 500 человек (проверка качества, Q21). */
export async function mailAddresses(userIds: string[]): Promise<Map<string, string>> {
  const addresses = new Map<string, string>();
  for (const chunk of chunksOf(userIds)) for (const [userId, address] of await mailAddressesTx(chunk)) addresses.set(userId, address);
  return addresses;
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

/** Сколько получателей читается одним запросом: список длиннее делится на части. */
const LOOKUP_CHUNK = 500;

/**
 * Годные идентификаторы частями. Негодный отбрасывается один: остальные получатели не должны остаться без
 * уведомления из-за одной строки (итоговая проверка волны 1, замечание F11).
 */
function chunksOf(userIds: string[]): string[][] {
  const valid = [...new Set(userIds.filter((id) => z.uuid().safeParse(id).success))];
  const chunks: string[][] = [];
  for (let from = 0; from < valid.length; from += LOOKUP_CHUNK) chunks.push(valid.slice(from, from + LOOKUP_CHUNK));
  return chunks;
}

/** Роли пользователей в организации: для уведомлений многим получателям, один запрос на 500 человек. */
export async function replyRoles(userIds: string[], orgId: string): Promise<Map<string, 'client_user' | 'client_admin'>> {
  const org = z.uuid().safeParse(orgId);
  const roles = new Map<string, 'client_user' | 'client_admin'>();
  if (!org.success) return roles;
  // Роли, прочитанные до транзакции вызывающего (проверка качества, Q2): база не нужна.
  const known = snapshotRoles(chunksOf(userIds).flat(), org.data);
  if (known) return known;
  for (const chunk of chunksOf(userIds)) for (const [userId, role] of await replyRolesTx(chunk, org.data)) roles.set(userId, role);
  return roles;
}

/** У кого из пользователей действует привязка Telegram: один запрос на 500 человек. */
export async function telegramLinkedMany(userIds: string[]): Promise<Set<string>> {
  const known = snapshotTelegramLinked(chunksOf(userIds).flat());
  if (known) return known;
  const linked = new Set<string>();
  for (const chunk of chunksOf(userIds)) for (const userId of await telegramLinkedManyTx(chunk)) linked.add(userId);
  return linked;
}
