import 'server-only';
import * as z from 'zod';
import {
  addGuestMembershipTx,
  domainHintTx,
  ensureGuestTx,
  ensureServiceOrgTx,
  finishGuestMergeTx,
  findVerifiedUserTx,
  guestSendersTx,
  orgByEmailDomainTx,
  pendingGuestMergesTx,
  senderOrgTx,
} from '../core/guests';

// Модуль hdu, слой api: гости из писем, служебная организация, опознание отправителя по адресу и домену
// (решения 11, 12, 15 вехи M4). Узкий файл: его берёт разбор писем в фоновом процессе.

export { SERVICE_ORG_ID } from '../pref';

/**
 * Адрес отправителя письма: всё, что принял разбор заголовка From (parseMailbox), в том числе домены в punycode
 * (.рф) и редкие знаки местной части. Строже, чем там, проверять нельзя: письмо иначе терялось бы (итоговая проверка M4).
 */
const address = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/u)
  .transform((value) => value.toLowerCase());
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export async function ensureServiceOrg(): Promise<void> {
  await ensureServiceOrgTx();
}

export async function ensureGuest(email: string, displayName: string | null, orgId: string): Promise<{ userId: string }> {
  return ensureGuestTx(address.parse(email), displayName, z.uuid().parse(orgId));
}

export async function findVerifiedUser(email: string): Promise<{ userId: string; lastOrgId: string | null } | null> {
  const parsed = address.safeParse(email);
  return parsed.success ? findVerifiedUserTx(parsed.data) : null;
}

export async function orgByEmailDomain(value: string): Promise<string | null> {
  const parsed = domain.safeParse(value);
  return parsed.success ? orgByEmailDomainTx(parsed.data) : null;
}

export async function senderOrg(userId: string, lastOrgId: string | null): Promise<string | null> {
  const user = z.uuid().safeParse(userId);
  if (!user.success) return null;
  const last = lastOrgId === null ? null : z.uuid().safeParse(lastOrgId);
  return senderOrgTx(user.data, last?.success ? last.data : null);
}

const uuids = z.array(z.uuid()).max(200);

/** Гости среди пользователей: адрес из письма и имя. */
export async function guestSenders(userIds: string[]): Promise<Map<string, { address: string; name: string }>> {
  return guestSendersTx(uuids.parse([...new Set(userIds)]));
}

export async function addGuestMembership(guestUserId: string, orgId: string): Promise<void> {
  await addGuestMembershipTx(z.uuid().parse(guestUserId), z.uuid().parse(orgId));
}

/** Организация клиента по домену адреса отправителя или null. */
export async function domainHint(emailAddress: string): Promise<{ orgId: string; name: string } | null> {
  const parsed = domain.safeParse(emailAddress.split('@')[1] ?? '');
  return parsed.success ? domainHintTx(parsed.data) : null;
}

export async function pendingGuestMerges(limit: number): Promise<{ mergeId: string; guestUserId: string; userId: string }[]> {
  return pendingGuestMergesTx(z.number().int().min(1).max(500).parse(limit));
}

export async function finishGuestMerge(mergeId: string, guestUserId: string): Promise<void> {
  await finishGuestMergeTx(z.uuid().parse(mergeId), z.uuid().parse(guestUserId));
}
