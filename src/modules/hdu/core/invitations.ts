import 'server-only';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { type ClientActor, type StaffActor, withActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { authUser } from '../auth-schema';
import { HduError } from '../error';
import type { ClientRole, MembershipSource } from '../pref';
import { invitations, memberships, organizations, staff } from '../schema';
import { newToken } from '../tokens';

// Модуль hdu, слой core: приглашения в организацию клиента (FR-ID-08). Токен хранится хешем.
// Создание и отзыв идут от имени приглашающего: политики базы пускают администратора клиента
// только в свою организацию и только от своего имени. Принятие выполняет система.

/** Приглашение живёт 7 дней (FR-ID-08). */
export const INVITATION_TTL_SEC = 7 * 24 * 3600;

const SYSTEM = { type: 'system', job: 'identity.invitation' } as const;

/** Действует: не принято, не отозвано, срок не вышел. */
const pending = () =>
  and(isNull(invitations.acceptedOn), isNull(invitations.revokedOn), gt(invitations.expiresOn, sql`now()`));

/**
 * Новое приглашение одной транзакцией с записью аудита. Действующий участник с этим подтверждённым адресом
 * приглашению не подлежит. Прежнее ждущее приглашение на тот же адрес в ту же организацию отменяется.
 */
export async function createInvitation(
  actor: ClientActor | StaffActor,
  input: { orgId: string; email: string; role: ClientRole },
): Promise<{ invitationId: string; token: string }> {
  const { token, hash } = newToken();
  const invitationId = await withIdentity(actor, async (tx) => {
    const member = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(authUser, eq(authUser.id, memberships.userId))
      .where(
        and(
          eq(memberships.orgId, input.orgId),
          eq(memberships.state, 'active'),
          // Гостя приглашают: принятие сделает его обычным участником.
          ne(memberships.source, 'guest'),
          eq(authUser.email, input.email),
          eq(authUser.emailVerified, true),
        ),
      )
      .limit(1);
    if (member.length > 0) throw new HduError('already_member');
    await tx
      .update(invitations)
      .set({ revokedOn: sql`now()` })
      .where(and(eq(invitations.orgId, input.orgId), eq(invitations.email, input.email), isNull(invitations.acceptedOn), isNull(invitations.revokedOn)));
    const row = (
      await tx
        .insert(invitations)
        .values({
          orgId: input.orgId,
          email: input.email,
          role: input.role,
          tokenHash: hash,
          invitedBy: actor.userId,
          expiresOn: sql`now() + make_interval(secs => ${INVITATION_TTL_SEC})`,
        })
        .returning({ invitationId: invitations.invitationId })
    )[0] as { invitationId: string };
    // Адрес в журнал не пишется: он есть в самом приглашении.
    await writeAudit(tx, { action: 'invitation.created', objectType: 'invitation', objectId: row.invitationId, orgId: input.orgId, diff: { role: input.role } });
    return row.invitationId;
  });
  return { invitationId, token };
}

export type InvitationRow = {
  invitationId: string;
  email: string;
  role: ClientRole;
  expiresOn: Date;
  acceptedOn: Date | null;
  revokedOn: Date | null;
};

/** Приглашения организации, новые первыми. Хеш токена не читается: у hub_app нет права на эту колонку. */
export async function listOrgInvitations(actor: ClientActor | StaffActor, orgId: string): Promise<InvitationRow[]> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({
        invitationId: invitations.invitationId,
        email: invitations.email,
        role: invitations.role,
        expiresOn: invitations.expiresOn,
        acceptedOn: invitations.acceptedOn,
        revokedOn: invitations.revokedOn,
      })
      .from(invitations)
      .where(eq(invitations.orgId, orgId))
      .orderBy(desc(invitations.createdOn), desc(invitations.invitationId)),
  );
  return rows as InvitationRow[];
}

/** Отзыв ждущего приглашения с записью аудита. Чужое, принятое и истёкшее приглашение для актора не найдено. */
export async function revokeOrgInvitation(actor: ClientActor | StaffActor, orgId: string, invitationId: string): Promise<void> {
  await withIdentity(actor, async (tx) => {
    const revoked = await tx
      .update(invitations)
      .set({ revokedOn: sql`now()` })
      .where(and(eq(invitations.invitationId, invitationId), eq(invitations.orgId, orgId), pending()))
      .returning({ invitationId: invitations.invitationId });
    if (revoked.length === 0) throw new HduError('not_found');
    await writeAudit(tx, { action: 'invitation.revoked', objectType: 'invitation', objectId: invitationId, orgId });
  });
}

/** Действующее приглашение по хешу токена: организация, адрес и есть ли уже учётная запись с этим адресом. */
export async function findPendingInvitation(tokenHash: string): Promise<{ orgName: string; email: string; hasAccount: boolean } | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const row = (
      await tx
        .select({ orgName: organizations.name, email: invitations.email })
        .from(invitations)
        .innerJoin(organizations, and(eq(organizations.orgId, invitations.orgId), eq(organizations.state, 'active')))
        .where(and(eq(invitations.tokenHash, tokenHash), pending()))
        .limit(1)
    )[0];
    if (!row) return null;
    const account = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, row.email)).limit(1);
    return { ...row, hasAccount: account.length > 0 };
  });
}

export type AcceptResult = { userId: string; orgId: string; created: boolean } | 'link_invalid' | 'email_taken' | 'sign_in_required';

/**
 * Принятие приглашения одной транзакцией от системы. Ссылка из письма доказала адрес для новой учётной
 * записи: она создаётся с подтверждённым адресом. Существующая учётная запись принимает приглашение
 * только из своей сессии (sessionUserId): иначе пересланная ссылка служила бы входом в неё на 7 дней
 * (проверка main, S3); приглашение при этом остаётся ждущим. Адрес сотрудника участником клиента не
 * становится. Отключённое членство приглашение не включает. Гостевое членство становится обычным.
 */
export async function acceptInvitationTx(tokenHash: string, name: string, sessionUserId: string | null): Promise<AcceptResult> {
  return withIdentity(SYSTEM, async (tx) => {
    const invitation = (
      await tx
        .select({
          invitationId: invitations.invitationId,
          orgId: invitations.orgId,
          email: invitations.email,
          role: invitations.role,
          invitedBy: invitations.invitedBy,
        })
        .from(invitations)
        .innerJoin(organizations, and(eq(organizations.orgId, invitations.orgId), eq(organizations.state, 'active')))
        .where(and(eq(invitations.tokenHash, tokenHash), pending()))
        .limit(1)
        .for('update', { of: invitations })
    )[0];
    if (!invitation?.orgId) return 'link_invalid';
    const orgId = invitation.orgId;

    let user = (await tx.select({ id: authUser.id, emailVerified: authUser.emailVerified }).from(authUser).where(eq(authUser.email, invitation.email)).limit(1))[0];
    if (user && (await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, user.id)).limit(1)).length > 0) return 'email_taken';
    if (user) {
      // Отключённое членство приглашение не включает: ответ тот же, что у недействительной ссылки.
      const passive = await tx
        .select({ state: memberships.state })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user.id), eq(memberships.state, 'passive')))
        .limit(1);
      if (passive.length > 0) return 'link_invalid';
      if (user.id !== sessionUserId) return 'sign_in_required';
    }
    const created = !user;
    if (!user) {
      user = (
        await tx
          .insert(authUser)
          .values({ name, email: invitation.email, emailVerified: true })
          .returning({ id: authUser.id, emailVerified: authUser.emailVerified })
      )[0] as { id: string; emailVerified: boolean };
    } else if (!user.emailVerified) {
      await tx.update(authUser).set({ emailVerified: true, claimedEmail: null, updatedAt: sql`now()` }).where(eq(authUser.id, user.id));
    }

    const current = (
      await tx
        .select({ state: memberships.state, source: memberships.source })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user.id)))
        .limit(1)
    )[0];
    if (current?.state === 'passive') return 'link_invalid';
    if (!current) {
      const byStaff = invitation.invitedBy
        ? (await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, invitation.invitedBy)).limit(1)).length > 0
        : false;
      const source: MembershipSource = byStaff ? 'staff' : 'invite';
      await tx.insert(memberships).values({ orgId, userId: user.id, role: invitation.role as ClientRole, source });
      await tx.update(invitations).set({ acceptedOn: sql`now()` }).where(eq(invitations.invitationId, invitation.invitationId));
      await writeAudit(tx, { action: 'invitation.accepted', objectType: 'invitation', objectId: invitation.invitationId, orgId });
      await writeAudit(tx, { action: 'member.joined', objectType: 'membership', objectId: user.id, orgId, diff: { role: invitation.role, source } });
    } else if (current.source === 'guest') {
      // Гость стал приглашённым участником: членство получает роль из приглашения и даёт вход.
      const byStaff = invitation.invitedBy
        ? (await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, invitation.invitedBy)).limit(1)).length > 0
        : false;
      const source: MembershipSource = byStaff ? 'staff' : 'invite';
      await tx
        .update(memberships)
        .set({ source, role: invitation.role as ClientRole })
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user.id)));
      await tx.update(invitations).set({ acceptedOn: sql`now()` }).where(eq(invitations.invitationId, invitation.invitationId));
      await writeAudit(tx, { action: 'invitation.accepted', objectType: 'invitation', objectId: invitation.invitationId, orgId });
      await writeAudit(tx, { action: 'member.joined', objectType: 'membership', objectId: user.id, orgId, diff: { role: invitation.role, source, from: 'guest' } });
    } else {
      // Уже действующий участник: приглашение принято, членство не меняется.
      await tx.update(invitations).set({ acceptedOn: sql`now()` }).where(eq(invitations.invitationId, invitation.invitationId));
      await writeAudit(tx, { action: 'invitation.accepted', objectType: 'invitation', objectId: invitation.invitationId, orgId });
    }
    await tx.update(authUser).set({ lastOrgId: orgId, updatedAt: sql`now()` }).where(eq(authUser.id, user.id));
    return { userId: user.id, orgId, created };
  });
}
