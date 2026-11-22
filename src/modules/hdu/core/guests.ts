import 'server-only';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { withIdentity } from '@/db/with-identity';
import { authUser } from '../auth-schema';
import { SERVICE_ORG_ID, SERVICE_ORG_NAME } from '../pref';
import { guestMerges, memberships, organizations, orgEmailDomains } from '../schema';
import { signInMemberships } from './access';
import { syntheticEmail } from '../util';

// Модуль hdu, слой core: служебная организация "Неопознанные" и гости из писем с неизвестных адресов
// (раздел 10.1, решения 12 и 15 вехи M4). Гость: учётная запись с искусственным адресом для входа, адрес из письма
// лежит в claimedEmail, членство guest. Войти гость не может: искусственный адрес не получает ссылок, членство
// guest не даёт входа (signInMemberships).

const SYSTEM = { type: 'system', job: 'identity.guest' } as const;
/** Предел имени гостя из поля From, знаков. */
const NAME_MAX = 100;

/** Служебная организация есть всегда, когда она нужна. Повтор ничего не меняет. */
export async function ensureServiceOrgTx(): Promise<void> {
  await withIdentity(SYSTEM, (tx) =>
    tx.insert(organizations).values({ orgId: SERVICE_ORG_ID, name: SERVICE_ORG_NAME, kind: 'service' }).onConflictDoNothing({ target: organizations.orgId }),
  );
}

/**
 * Гость по адресу из письма: один на адрес. Имя из поля From или начало адреса. Членство guest в указанной
 * организации (служебной или организации клиента по домену) создаётся, если его нет.
 */
export async function ensureGuestTx(address: string, displayName: string | null, orgId: string): Promise<{ userId: string }> {
  if (orgId === SERVICE_ORG_ID) await ensureServiceOrgTx();
  return withIdentity(SYSTEM, async (tx) => {
    // Один гость на адрес: параллельные письма с одного адреса не создают двух гостей.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`guest:${address}`}))`);
    const existing = await tx
      .select({ userId: authUser.id })
      .from(authUser)
      .innerJoin(memberships, and(eq(memberships.userId, authUser.id), eq(memberships.source, 'guest')))
      .where(and(eq(authUser.claimedEmail, address), eq(authUser.emailVerified, false)))
      .limit(1);
    let userId = existing[0]?.userId;
    if (!userId) {
      const name = (displayName ?? '').trim().slice(0, NAME_MAX) || (address.split('@')[0] ?? address);
      const [created] = await tx
        .insert(authUser)
        .values({ name, email: syntheticEmail(), emailVerified: false, claimedEmail: address })
        .returning({ id: authUser.id });
      if (!created) throw new Error('гость не создан');
      userId = created.id;
    }
    const joined = await tx
      .insert(memberships)
      .values({ orgId, userId, role: 'client_user', source: 'guest' })
      .onConflictDoNothing()
      .returning({ userId: memberships.userId });
    // Гостевое членство даёт видимость своих личных обращений организации: в журнал (итоговая проверка M4, I10).
    if (joined.length > 0)
      await writeAudit(tx, { action: 'member.joined', objectType: 'membership', objectId: userId, orgId, diff: { role: 'client_user', source: 'guest' } });
    return { userId };
  });
}

/** Подтверждённый пользователь по адресу (FR-EM-03): для опознания отправителя письма. */
export async function findVerifiedUserTx(address: string): Promise<{ userId: string; lastOrgId: string | null } | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: authUser.id, lastOrgId: authUser.lastOrgId })
      .from(authUser)
      .where(and(eq(authUser.email, address), eq(authUser.emailVerified, true)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Организация обращения из письма опознанного пользователя (FR-EM-03): последняя, в которой он работал, если членство
 * там даёт вход; иначе самая ранняя такая. Нет членства, дающего вход (сотрудник, отключённый сервер): null.
 */
export async function senderOrgTx(userId: string, lastOrgId: string | null): Promise<string | null> {
  const rows = await withIdentity(SYSTEM, (tx) => signInMemberships(tx, eq(memberships.userId, userId)).orderBy(asc(memberships.createdOn)));
  return rows.find((row) => row.orgId === lastOrgId)?.orgId ?? rows[0]?.orgId ?? null;
}

/** Организация клиента по домену почты (FR-EM-06): только действующая. */
export async function orgByEmailDomainTx(domain: string): Promise<string | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ orgId: orgEmailDomains.orgId })
      .from(orgEmailDomains)
      .innerJoin(organizations, and(eq(organizations.orgId, orgEmailDomains.orgId), eq(organizations.state, 'active'), eq(organizations.kind, 'client')))
      .where(eq(orgEmailDomains.domain, domain))
      .limit(1),
  );
  return rows[0]?.orgId ?? null;
}

/** Гости среди пользователей: адрес из письма и имя (очередь "Неопознанные", решение 12). Не гость: нет в ответе. */
export async function guestSendersTx(userIds: string[]): Promise<Map<string, { address: string; name: string }>> {
  if (userIds.length === 0) return new Map();
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .selectDistinct({ userId: authUser.id, address: authUser.claimedEmail, name: authUser.name })
      .from(authUser)
      .innerJoin(memberships, and(eq(memberships.userId, authUser.id), eq(memberships.source, 'guest')))
      .where(and(inArray(authUser.id, userIds), eq(authUser.emailVerified, false))),
  );
  return new Map(rows.filter((r) => r.address).map((r) => [r.userId, { address: r.address as string, name: r.name }]));
}

/** Членство guest в организации клиента при привязке обращения (решение 13). Только у гостя, повтор ничего не меняет. */
export async function addGuestMembershipTx(guestUserId: string, orgId: string): Promise<void> {
  await withIdentity(SYSTEM, async (tx) => {
    const guest = await tx.select({ id: authUser.id }).from(authUser).where(and(eq(authUser.id, guestUserId), eq(authUser.emailVerified, false))).limit(1);
    if (guest.length === 0) return;
    const joined = await tx
      .insert(memberships)
      .values({ orgId, userId: guestUserId, role: 'client_user', source: 'guest' })
      .onConflictDoNothing()
      .returning({ userId: memberships.userId });
    if (joined.length > 0)
      await writeAudit(tx, { action: 'member.joined', objectType: 'membership', objectId: guestUserId, orgId, diff: { role: 'client_user', source: 'guest' } });
  });
}

/** Подсказка организации по домену адреса (FR-EM-06): при привязке сотрудник видит, чей это домен. */
export async function domainHintTx(domain: string): Promise<{ orgId: string; name: string } | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ orgId: organizations.orgId, name: organizations.name })
      .from(orgEmailDomains)
      .innerJoin(organizations, and(eq(organizations.orgId, orgEmailDomains.orgId), eq(organizations.state, 'active'), eq(organizations.kind, 'client')))
      .where(eq(orgEmailDomains.domain, domain))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Слияние гостя с пользователем, который доказал владение адресом (решение 13): принял приглашение или подтвердил
 * адрес. В транзакции принятия или подтверждения. Повтор ничего не меняет.
 */
export async function recordGuestMergesTx(tx: Tx, address: string, userId: string): Promise<number> {
  const guests = await tx
    .selectDistinct({ id: authUser.id })
    .from(authUser)
    .innerJoin(memberships, and(eq(memberships.userId, authUser.id), eq(memberships.source, 'guest')))
    .where(and(eq(authUser.claimedEmail, address), eq(authUser.emailVerified, false), ne(authUser.id, userId)));
  for (const guest of guests) await upsertMergeTx(tx, guest.id, userId);
  return guests.length;
}

/**
 * Слияние гостя, которого назвало принятое приглашение (решение 13): только он, а не любой гость с этим адресом.
 * Иначе принятие постороннего приглашения забирало бы обращения из писем, подделанных под этот адрес (итоговая
 * проверка M4, замечание I5).
 */
export async function recordGuestMergeTx(tx: Tx, guestUserId: string, userId: string): Promise<boolean> {
  if (guestUserId === userId) return false;
  const guest = await tx
    .select({ id: authUser.id })
    .from(authUser)
    .innerJoin(memberships, and(eq(memberships.userId, authUser.id), eq(memberships.source, 'guest')))
    .where(and(eq(authUser.id, guestUserId), eq(authUser.emailVerified, false)))
    .limit(1);
  if (guest.length === 0) return false;
  await upsertMergeTx(tx, guestUserId, userId);
  return true;
}

/** Запись слияния. Уже записанная пара применяется заново: письмо, пришедшее от гостя после перехода, тоже перейдёт. */
async function upsertMergeTx(tx: Tx, guestUserId: string, userId: string): Promise<void> {
  await tx
    .insert(guestMerges)
    .values({ guestUserId, userId })
    .onConflictDoUpdate({ target: [guestMerges.guestUserId, guestMerges.userId], set: { appliedOn: null } });
  await writeAudit(tx, { action: 'guest.merge_recorded', objectType: 'user', objectId: guestUserId, diff: { userId } });
}

/** Ждущие слияния для задачи раз в минуту, старые первыми. */
export async function pendingGuestMergesTx(limit: number): Promise<{ mergeId: string; guestUserId: string; userId: string }[]> {
  return withActor({ type: 'system', job: 'identity.guest-merge' }, (tx) =>
    tx
      .select({ mergeId: guestMerges.mergeId, guestUserId: guestMerges.guestUserId, userId: guestMerges.userId })
      .from(guestMerges)
      .where(isNull(guestMerges.appliedOn))
      .orderBy(asc(guestMerges.createdOn))
      .limit(limit),
  );
}

/** Слияние применено: гость больше нигде не участник (его членства passive), отметка применения. */
export async function finishGuestMergeTx(mergeId: string, guestUserId: string): Promise<void> {
  await withIdentity(SYSTEM, async (tx) => {
    await tx.update(memberships).set({ state: 'passive' }).where(and(eq(memberships.userId, guestUserId), eq(memberships.state, 'active')));
    await writeAudit(tx, { action: 'guest.merged', objectType: 'user', objectId: guestUserId, diff: { mergeId } });
  });
  await withActor({ type: 'system', job: 'identity.guest-merge' }, (tx) =>
    tx.update(guestMerges).set({ appliedOn: sql`now()` }).where(eq(guestMerges.mergeId, mergeId)),
  );
}
