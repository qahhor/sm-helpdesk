import 'server-only';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { ClientActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authUser } from '../auth-schema';
import { EMAIL_TOKEN_TTL_SEC } from '../pref';
import { emailTokens, memberships } from '../schema';
import { signInMemberships } from './access';
import { newToken } from '../tokens';

// Модуль hdu, слой core: адрес email клиента (FR-ID-06, FR-ID-07, решение 0016).
// Адрес становится адресом для входа только после подтверждения ссылкой из письма.

/**
 * Кому можно отправить ссылку для входа: учётная запись с этим подтверждённым адресом, не сотрудник,
 * действующий участник хотя бы одной действующей организации.
 */
export async function isLoginLinkRecipient(email: string): Promise<boolean> {
  return withIdentity({ type: 'system', job: 'identity.login-link' }, async (tx) => {
    const account = (
      await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(and(eq(authUser.email, email), eq(authUser.emailVerified, true)))
        .limit(1)
    )[0];
    if (!account) return false;
    // Общее условие входа клиента (core/access.ts): гостю, сотруднику и клиенту отключённого сервера ссылка не уходит.
    return (await signInMemberships(tx, eq(memberships.userId, account.id)).limit(1)).length > 0;
  });
}

/**
 * Новая ссылка подтверждения адреса. Прежние неиспользованные ссылки пользователя отменяются,
 * адрес запоминается как указанный, но не подтверждённый. Работает от имени самого клиента:
 * политики базы не дают создать ссылку для чужой учётной записи.
 */
export async function createEmailToken(actor: ClientActor, email: string): Promise<string> {
  const { token, hash } = newToken();
  await withIdentity(actor, async (tx) => {
    await tx
      .update(emailTokens)
      .set({ usedOn: sql`now()` })
      .where(and(eq(emailTokens.userId, actor.userId), isNull(emailTokens.usedOn)));
    await tx.insert(emailTokens).values({
      userId: actor.userId,
      email,
      tokenHash: hash,
      expiresOn: sql`now() + make_interval(secs => ${EMAIL_TOKEN_TTL_SEC})`,
    });
    await tx.update(authUser).set({ claimedEmail: email, updatedAt: sql`now()` }).where(eq(authUser.id, actor.userId));
  });
  return token;
}

export type ConfirmResult = 'ok' | 'link_invalid' | 'email_taken' | 'wrong_account';

const UNIQUE_VIOLATION = '23505';

/**
 * Подтверждение адреса по ссылке. Одна транзакция: адрес становится адресом для входа,
 * указанный адрес очищается, ссылка помечается использованной, запись в журнале аудита (без адреса).
 * Ссылку тратит только тот, кто её запросил (userId вошедшего): иначе чужой человек указал бы адрес
 * жертвы, жертва нажала бы ссылку, и адрес достался бы ему (проверка main, S2). Чужая ссылка не тратится.
 */
export async function confirmEmailToken(tokenHash: string, userId: string, ip?: string | null): Promise<ConfirmResult> {
  try {
    return await withIdentity({ type: 'system', job: 'identity.email', ip }, async (tx) => {
      const row = (
        await tx
          .select({ tokenId: emailTokens.tokenId, userId: emailTokens.userId, email: emailTokens.email })
          .from(emailTokens)
          .where(and(eq(emailTokens.tokenHash, tokenHash), isNull(emailTokens.usedOn), gt(emailTokens.expiresOn, sql`now()`)))
          .limit(1)
          .for('update')
      )[0];
      if (!row) return 'link_invalid';
      if (row.userId !== userId) return 'wrong_account';
      await tx.update(emailTokens).set({ usedOn: sql`now()` }).where(eq(emailTokens.tokenId, row.tokenId));
      // Один подтверждённый адрес принадлежит одной учётной записи. Ссылка при этом тратится:
      // ответ "адрес занят" человек видит только после доказательства, что ящик его.
      const taken = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(and(eq(authUser.email, row.email), ne(authUser.id, row.userId)))
        .limit(1);
      if (taken.length > 0) return 'email_taken';
      await tx
        .update(authUser)
        .set({ email: row.email, emailVerified: true, claimedEmail: null, updatedAt: sql`now()` })
        .where(eq(authUser.id, row.userId));
      await writeAudit(tx, { action: 'user.email_confirmed', objectType: 'user', objectId: row.userId });
      return 'ok';
    });
  } catch (error) {
    // Тот же адрес подтвердили одновременно: уникальность в базе решает, кто первый.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'email_taken';
    throw error;
  }
}

/** Отмечает шаг первого входа пройденным (FR-ID-07). Повторный вызов время не меняет. */
export async function markOnboarded(userId: string): Promise<void> {
  await withIdentity({ type: 'system', job: 'identity.onboarding' }, (tx) =>
    tx.update(authUser).set({ onboardedAt: sql`now()` }).where(and(eq(authUser.id, userId), isNull(authUser.onboardedAt))),
  );
}

/** Нужно ли показать подсказки первого входа (UX-C-14): шаг первого входа пройден, подсказки ещё не скрыты. */
export async function hintsPendingFor(userId: string): Promise<boolean> {
  const [row] = await withIdentity({ type: 'system', job: 'identity.hints' }, (tx) =>
    tx.select({ onboardedAt: authUser.onboardedAt, hintsSeenAt: authUser.hintsSeenAt }).from(authUser).where(eq(authUser.id, userId)),
  );
  return row !== undefined && row.onboardedAt !== null && row.hintsSeenAt === null;
}

/** Скрывает подсказки первого входа навсегда. Повторный вызов время не меняет. */
export async function markHintsSeen(userId: string): Promise<void> {
  await withIdentity({ type: 'system', job: 'identity.hints' }, (tx) =>
    tx.update(authUser).set({ hintsSeenAt: sql`now()` }).where(and(eq(authUser.id, userId), isNull(authUser.hintsSeenAt))),
  );
}

/**
 * Записывает версию политики обработки данных, которую увидел пользователь (раздел 14.6 ТЗ), и запись
 * журнала аудита: так видна история согласия, а не только последняя редакция (проверка main, Q17).
 * Та же версия повторно ничего не пишет.
 */
export async function setPolicyVersion(userId: string, version: string, ip?: string | null): Promise<void> {
  await withIdentity({ type: 'system', job: 'identity.policy', ip }, async (tx) => {
    const changed = await tx
      .update(authUser)
      .set({ policyVersion: version, updatedAt: sql`now()` })
      .where(and(eq(authUser.id, userId), sql`${authUser.policyVersion} is distinct from ${version}`))
      .returning({ id: authUser.id });
    if (changed.length > 0) await writeAudit(tx, { action: 'user.policy_acknowledged', objectType: 'user', objectId: userId, diff: { version } });
  });
}
