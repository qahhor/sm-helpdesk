import 'server-only';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { type ClientActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/audit';
import { authUser } from '../auth-schema';
import { contactIdentities, linkCodes, memberships, organizations } from '../schema';
import { newToken } from '../tokens';
import { isSyntheticEmail } from '../util';

// Модуль hdu, слой core: привязка Telegram (FR-ID-14, решение 94 ТЗ, решение 0018).
// Код привязки создаёт сессия портала, принимает его система по команде /start из бота.

/** Код привязки живёт 10 минут. */
export const LINK_CODE_TTL_SEC = 10 * 60;
const SYSTEM = { type: 'system', job: 'identity.telegram' } as const;

/** Новый код привязки для самого клиента. Прежние неиспользованные коды отменяются. */
export async function createLinkCode(actor: ClientActor): Promise<string> {
  const { token, hash } = newToken();
  await withIdentity(actor, async (tx) => {
    await tx
      .update(linkCodes)
      .set({ usedOn: sql`now()` })
      .where(and(eq(linkCodes.userId, actor.userId), eq(linkCodes.kind, 'telegram'), isNull(linkCodes.usedOn)));
    await tx.insert(linkCodes).values({
      userId: actor.userId,
      kind: 'telegram',
      codeHash: hash,
      expiresOn: sql`now() + make_interval(secs => ${LINK_CODE_TTL_SEC})`,
    });
  });
  return token;
}

export type LinkedAccount = { userId: string; userName: string; orgName: string | null; email: string | null; locale: Locale | null };

/**
 * Привязка по коду из команды /start. Одна транзакция от системы: код действует и тратится, аккаунт
 * Telegram не принадлежит другому пользователю (иначе ничего не меняется), прежняя привязка пользователя
 * заменяется, запись telegram.linked в журнале аудита без идентификатора Telegram.
 */
export async function consumeLinkCode(
  codeHash: string,
  telegram: { externalId: string; displayName: string },
): Promise<LinkedAccount | 'invalid' | 'taken'> {
  return withIdentity(SYSTEM, async (tx) => {
    const code = (
      await tx
        .select({ linkCodeId: linkCodes.linkCodeId, userId: linkCodes.userId })
        .from(linkCodes)
        .where(and(eq(linkCodes.codeHash, codeHash), eq(linkCodes.kind, 'telegram'), isNull(linkCodes.usedOn), gt(linkCodes.expiresOn, sql`now()`)))
        .limit(1)
        .for('update')
    )[0];
    if (!code) return 'invalid';
    const owner = (
      await tx
        .select({ userId: contactIdentities.userId })
        .from(contactIdentities)
        .where(and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.externalId, telegram.externalId)))
        .limit(1)
    )[0];
    if (owner && owner.userId !== code.userId) return 'taken';

    await tx.update(linkCodes).set({ usedOn: sql`now()` }).where(eq(linkCodes.linkCodeId, code.linkCodeId));
    await tx.delete(contactIdentities).where(and(eq(contactIdentities.userId, code.userId), eq(contactIdentities.kind, 'telegram')));
    await tx.insert(contactIdentities).values({
      userId: code.userId,
      kind: 'telegram',
      externalId: telegram.externalId,
      displayName: telegram.displayName,
      verified: 'linked',
      verifiedOn: sql`now()`,
    });
    await writeAudit(tx, { action: 'telegram.linked', objectType: 'user', objectId: code.userId });

    const user = (
      await tx
        .select({ name: authUser.name, email: authUser.email, emailVerified: authUser.emailVerified, locale: authUser.locale, lastOrgId: authUser.lastOrgId })
        .from(authUser)
        .where(eq(authUser.id, code.userId))
        .limit(1)
    )[0] as { name: string; email: string; emailVerified: boolean; locale: Locale | null; lastOrgId: string | null };
    // Организация последнего входа, иначе любая действующая.
    const org = (
      await tx
        .select({ name: organizations.name })
        .from(memberships)
        .innerJoin(organizations, and(eq(organizations.orgId, memberships.orgId), eq(organizations.state, 'active')))
        .where(and(eq(memberships.userId, code.userId), eq(memberships.state, 'active')))
        .orderBy(desc(sql`${organizations.orgId} = ${user.lastOrgId}`), organizations.name)
        .limit(1)
    )[0];
    return {
      userId: code.userId,
      userName: user.name,
      orgName: org?.name ?? null,
      email: user.emailVerified && !isSyntheticEmail(user.email) ? user.email : null,
      locale: user.locale,
    };
  });
}

/** Привязка по идентификатору Telegram: чей это аккаунт и на каком языке ему отвечать. */
export async function findTelegramIdentity(externalId: string): Promise<{ userId: string; locale: Locale | null } | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: contactIdentities.userId, locale: authUser.locale })
      .from(contactIdentities)
      .innerJoin(authUser, eq(authUser.id, contactIdentities.userId))
      .where(and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.externalId, externalId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Отвязка командой из бота. Возвращает, была ли привязка. */
export async function unlinkByExternalId(externalId: string): Promise<boolean> {
  return withIdentity(SYSTEM, async (tx) => {
    const removed = await tx
      .delete(contactIdentities)
      .where(and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.externalId, externalId)))
      .returning({ userId: contactIdentities.userId });
    for (const row of removed) await writeAudit(tx, { action: 'telegram.unlinked', objectType: 'user', objectId: row.userId });
    return removed.length > 0;
  });
}

/** Отвязка кнопкой в портале: клиент удаляет только свою привязку. Возвращает идентификатор отвязанного аккаунта. */
export async function unlinkOwn(actor: ClientActor): Promise<string | null> {
  return withIdentity(actor, async (tx) => {
    const removed = await tx
      .delete(contactIdentities)
      .where(and(eq(contactIdentities.userId, actor.userId), eq(contactIdentities.kind, 'telegram')))
      .returning({ externalId: contactIdentities.externalId });
    if (removed.length === 0) return null;
    await writeAudit(tx, { action: 'telegram.unlinked', objectType: 'user', objectId: actor.userId });
    return removed[0]?.externalId ?? null;
  });
}

/** Своя привязка Telegram глазами клиента. */
export async function findOwnIdentity(actor: ClientActor): Promise<{ displayName: string | null; verifiedOn: Date } | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ displayName: contactIdentities.displayName, verifiedOn: contactIdentities.verifiedOn })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.userId, actor.userId), eq(contactIdentities.kind, 'telegram')))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** Язык писем и сообщений бота в учётной записи. */
export async function setUserLocale(userId: string, locale: Locale): Promise<void> {
  await withIdentity(SYSTEM, (tx) => tx.update(authUser).set({ locale }).where(eq(authUser.id, userId)));
}

