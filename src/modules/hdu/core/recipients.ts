import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import type { Locale } from '@/i18n/locales';
import { authUser } from '../auth-schema';
import { memberships, organizations, staff } from '../schema';

// Модуль hdu, слой core: куда отправить письмо пользователю (решение 2 вехи M4). Адрес берётся в момент отправки:
// сменённый или обезличенный адрес писем не получает. Письмо уходит только на подтверждённый адрес; у гостя
// из письма с неизвестного адреса (решение 12) это адрес, с которого он написал.

const SYSTEM = { type: 'system', job: 'identity.recipient' } as const;

export type MailRecipient = { address: string; locale: Locale | null; name: string };

export async function mailRecipientTx(userId: string): Promise<MailRecipient | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const user = (
      await tx
        .select({ name: authUser.name, email: authUser.email, emailVerified: authUser.emailVerified, claimedEmail: authUser.claimedEmail, locale: authUser.locale })
        .from(authUser)
        .where(eq(authUser.id, userId))
        .limit(1)
    )[0];
    if (!user) return null;
    if (user.emailVerified) return { address: user.email, locale: user.locale ?? null, name: user.name };
    if (!user.claimedEmail) return null;
    const guest = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.source, 'guest')))
      .limit(1);
    return guest.length > 0 ? { address: user.claimedEmail, locale: user.locale ?? null, name: user.name } : null;
  });
}

/**
 * Руководители линии (FR-SLA-06, решение 7 вехи M4): признак is_lead у действующего сотрудника линии.
 * Первая линия: agent_l1. Вторая линия: agent_l2 и care (раздел 7.19).
 */
export async function lineLeadsTx(line: 'l1' | 'l2'): Promise<string[]> {
  const roles = line === 'l1' ? (['agent_l1'] as const) : (['agent_l2', 'care'] as const);
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.isLead, true), eq(staff.state, 'active'), inArray(staff.role, [...roles]))),
  );
  return rows.map((r) => r.userId);
}

/** Действующие администраторы портала (FR-SLA-12): им напоминание о праздниках. */
export async function adminIdsTx(): Promise<string[]> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.role, 'admin'), eq(staff.state, 'active'))),
  );
  return rows.map((r) => r.userId);
}

/** Название организации для служебного сообщения дежурным (решение 8). */
export async function organizationNameTx(orgId: string): Promise<string | null> {
  const rows = await withIdentity(SYSTEM, (tx) => tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.orgId, orgId)).limit(1));
  return rows[0]?.name ?? null;
}
