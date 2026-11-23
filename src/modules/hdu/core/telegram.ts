import 'server-only';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { type ClientActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import type { Locale } from '@/i18n/locales';
import { writeAudit } from '@/modules/hdc/api';
import { authUser } from '../auth-schema';
import { LOGIN_BOT_LINK_TTL_SEC } from '../pref';
import { contactIdentities, linkCodes, loginCodes, memberships, organizations } from '../schema';
import { newToken } from '../tokens';
import { signInMemberships } from './access';
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
export async function findOwnIdentity(actor: ClientActor): Promise<{ displayName: string | null; verifiedOn: Date; blocked: boolean } | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ displayName: contactIdentities.displayName, verifiedOn: contactIdentities.verifiedOn, blocked: contactIdentities.isBlocked })
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


// --- Запасной вход из бота (задача 17) ---

type Tx = Parameters<Parameters<typeof withIdentity>[1]>[0];

/**
 * Может ли пользователь войти по ссылке из бота: аккаунт Telegram привязан к нему и не заблокирован,
 * и выполняется общее условие входа клиента (core/access.ts).
 */
async function canSignInFromBot(tx: Tx, userId: string, externalId: string | null): Promise<boolean> {
  const identity = await tx
    .select({ userId: contactIdentities.userId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.userId, userId),
        eq(contactIdentities.kind, 'telegram'),
        eq(contactIdentities.isBlocked, false),
        ...(externalId ? [eq(contactIdentities.externalId, externalId)] : []),
      ),
    )
    .limit(1);
  if (identity.length === 0) return false;
  // Общее условие входа клиента (core/access.ts): не сотрудник, негостевое членство, действующие организация и сервер.
  return (await signInMemberships(tx, eq(memberships.userId, userId)).limit(1)).length > 0;
}

/**
 * Новая ссылка входа для привязанного аккаунта Telegram. Пусто, если входить нельзя.
 * Прежние неиспользованные ссылки пользователя отменяются. Токен хранится хешем.
 */
export async function createLoginCode(externalId: string): Promise<{ token: string; userId: string } | null> {
  const { token, hash } = newToken();
  return withIdentity(SYSTEM, async (tx) => {
    const identity = (
      await tx
        .select({ userId: contactIdentities.userId })
        .from(contactIdentities)
        .where(and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.externalId, externalId)))
        .limit(1)
    )[0];
    if (!identity || !(await canSignInFromBot(tx, identity.userId, externalId))) return null;
    await tx
      .update(loginCodes)
      .set({ usedOn: sql`now()` })
      .where(and(eq(loginCodes.userId, identity.userId), eq(loginCodes.channel, 'telegram'), isNull(loginCodes.usedOn)));
    await tx.insert(loginCodes).values({
      userId: identity.userId,
      channel: 'telegram',
      codeHash: hash,
      expiresOn: sql`now() + make_interval(secs => ${LOGIN_BOT_LINK_TTL_SEC})`,
    });
    return { token, userId: identity.userId };
  });
}

/**
 * Нажатие "Войти" на странице ссылки из бота. Ссылка действует и тратится, пользователь по-прежнему
 * может входить из бота (привязка не снята, членство не отключено). Запись user.signed_in_telegram
 * с адресом запроса (угроза T30). Возвращает пользователя или пусто.
 */
export async function consumeLoginCode(codeHash: string, ip: string | null): Promise<string | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const code = (
      await tx
        .select({ loginCodeId: loginCodes.loginCodeId, userId: loginCodes.userId })
        .from(loginCodes)
        .where(and(eq(loginCodes.codeHash, codeHash), eq(loginCodes.channel, 'telegram'), isNull(loginCodes.usedOn), gt(loginCodes.expiresOn, sql`now()`)))
        .limit(1)
        .for('update')
    )[0];
    if (!code) return null;
    await tx.update(loginCodes).set({ usedOn: sql`now()` }).where(eq(loginCodes.loginCodeId, code.loginCodeId));
    if (!(await canSignInFromBot(tx, code.userId, null))) return null;
    await writeAudit(tx, { action: 'user.signed_in_telegram', objectType: 'user', objectId: code.userId, ip });
    return code.userId;
  });
}
