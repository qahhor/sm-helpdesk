import 'server-only';
import * as z from 'zod';
import { ensureGuestTx, ensureServiceOrgTx, findVerifiedUserTx, orgByEmailDomainTx, senderOrgTx } from '../core/guests';

// Модуль hdu, слой api: гости из писем, служебная организация, опознание отправителя по адресу и домену
// (решения 11, 12, 15 вехи M4). Узкий файл: его берёт разбор писем в фоновом процессе.

export { SERVICE_ORG_ID } from '../pref';

const address = z.email().max(320).transform((value) => value.toLowerCase());
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
