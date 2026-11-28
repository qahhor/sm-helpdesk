import 'server-only';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import type { Locale } from '@/i18n/locales';
import { authUser } from '../auth-schema';
import { contactIdentities, memberships, organizations, servers, staff } from '../schema';

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
 * Адреса для писем сразу нескольких пользователей (проверка качества, Q21): то же правило, что у mailRecipientTx,
 * одной транзакцией. Подтверждённый адрес; у гостя заявленный. Кого в ответе нет, тому писать некуда.
 */
export async function mailAddressesTx(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  return withIdentity(SYSTEM, async (tx) => {
    const users = await tx
      .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified, claimedEmail: authUser.claimedEmail })
      .from(authUser)
      .where(inArray(authUser.id, userIds));
    const claimed = users.filter((user) => !user.emailVerified && user.claimedEmail);
    const guests =
      claimed.length > 0
        ? new Set((await tx.select({ userId: memberships.userId }).from(memberships).where(and(inArray(memberships.userId, claimed.map((user) => user.id)), eq(memberships.source, 'guest')))).map((row) => row.userId))
        : new Set<string>();
    const addresses = new Map<string, string>();
    for (const user of users) {
      if (user.emailVerified) addresses.set(user.id, user.email);
      else if (user.claimedEmail && guests.has(user.id)) addresses.set(user.id, user.claimedEmail);
    }
    return addresses;
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

/** Действующие сотрудники роли (план M7, задача 8): сводка модерации идей роли product. */
export async function staffIdsWithRoleTx(role: 'product' | 'admin'): Promise<string[]> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.role, role), eq(staff.state, 'active'))),
  );
  return rows.map((r) => r.userId);
}

/** Название организации для служебного сообщения дежурным (решение 8). */
export async function organizationNameTx(orgId: string): Promise<string | null> {
  const rows = await withIdentity(SYSTEM, (tx) => tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.orgId, orgId)).limit(1));
  return rows[0]?.name ?? null;
}

/**
 * Роль, с которой ответ из письма публикуется от имени пользователя (решение 16 вехи M4): членство действующее,
 * организация действующая, пользователь не сотрудник. Обычному участнику нужен и действующий сервер Smartup, как при
 * входе (signInMembership); гость входа не имеет, у него сервера нет, его ответ принимается по членству guest.
 */
export async function replyRoleTx(userId: string, orgId: string): Promise<'client_user' | 'client_admin' | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.orgId, memberships.orgId))
      .leftJoin(servers, eq(servers.serverId, organizations.serverId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.orgId, orgId),
          eq(memberships.state, 'active'),
          eq(organizations.state, 'active'),
          or(eq(memberships.source, 'guest'), eq(servers.state, 'active')),
          sql`not exists (select 1 from ${staff} where ${staff.userId} = ${memberships.userId})`,
        ),
      )
      .limit(1),
  );
  return rows[0]?.role ?? null;
}

/**
 * Действующая привязка Telegram: чат и язык пользователя (план M4b, решения 1 и 5). Берётся в момент отправки.
 * Нет привязки или человек заблокировал бота: null.
 */
export async function telegramChatTx(userId: string): Promise<{ chatId: string; locale: Locale | null } | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ chatId: contactIdentities.externalId, locale: authUser.locale })
      .from(contactIdentities)
      .innerJoin(authUser, eq(authUser.id, contactIdentities.userId))
      .where(and(eq(contactIdentities.userId, userId), eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.isBlocked, false)))
      .limit(1),
  );
  const row = rows[0];
  return row ? { chatId: row.chatId, locale: row.locale ?? null } : null;
}

/**
 * Человек заблокировал бота: Telegram ответил 403 (план M4b, решение 5). Отправка в этот чат прекращается до новой
 * привязки, которая заменяет строку и снимает отметку.
 */
export async function markTelegramBlockedTx(chatId: string): Promise<void> {
  await withIdentity(SYSTEM, async (tx) => {
    // Запись в журнал только при смене состояния: повторный отказ Telegram строку не трогает (M4b, мелкое 5).
    const changed = await tx
      .update(contactIdentities)
      .set({ isBlocked: true })
      .where(and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.externalId, chatId), eq(contactIdentities.isBlocked, false)))
      .returning({ userId: contactIdentities.userId });
    for (const row of changed) await writeAudit(tx, { action: 'telegram.bot_blocked', objectType: 'user', objectId: row.userId });
  });
}

/**
 * Роли сразу нескольких пользователей в организации: то же условие, что у replyRoleTx, одним запросом
 * (аудит 23.11.2026, находка A4). Кого в ответе нет, тот обращения организации не видит.
 */
export async function replyRolesTx(userIds: string[], orgId: string): Promise<Map<string, 'client_user' | 'client_admin'>> {
  if (userIds.length === 0) return new Map();
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.orgId, memberships.orgId))
      .leftJoin(servers, eq(servers.serverId, organizations.serverId))
      .where(
        and(
          inArray(memberships.userId, userIds),
          eq(memberships.orgId, orgId),
          eq(memberships.state, 'active'),
          eq(organizations.state, 'active'),
          or(eq(memberships.source, 'guest'), eq(servers.state, 'active')),
          sql`not exists (select 1 from ${staff} where ${staff.userId} = ${memberships.userId})`,
        ),
      ),
  );
  return new Map(rows.map((row) => [row.userId, row.role as 'client_user' | 'client_admin']));
}

/** У кого из пользователей действует привязка Telegram (есть и бот не заблокирован): одним запросом. */
export async function telegramLinkedManyTx(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: contactIdentities.userId })
      .from(contactIdentities)
      .where(and(inArray(contactIdentities.userId, userIds), eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.isBlocked, false))),
  );
  return new Set(rows.map((row) => row.userId));
}
