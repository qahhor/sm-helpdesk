import 'server-only';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Actor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { authAccount, authTwoFactor, authUser } from '../auth-schema';
import { HduError } from '../error';
import type { HumanStaffRole, RecordState, StaffRole } from '../pref';
import { invitations, memberships, staff } from '../schema';
import { newToken } from '../tokens';
import { revokeUserSessions } from './sessions';

// Модуль hdu, слой core: сотрудники. Операции с данными под ролью hub_auth.
// Права актора проверяет слой api, политики базы страхуют от ошибки в нём.

const SYSTEM = { type: 'system', job: 'identity.staff' } as const;

/** Приглашение сотрудника живёт 24 часа (решение 0015): ссылка даёт права в рабочем месте. */
export const STAFF_INVITATION_TTL_SEC = 24 * 3600;
const CREDENTIAL = 'credential';

export type StaffInfo = { role: StaffRole; state: RecordState; isLead: boolean };

/** Строка сотрудника по идентификатору пользователя. Пусто, если пользователь не сотрудник. */
export async function findStaff(userId: string): Promise<StaffInfo | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ role: staff.role, state: staff.state, isLead: staff.isLead })
      .from(staff)
      .where(eq(staff.userId, userId))
      .limit(1),
  );
  return rows[0] ?? null;
}

export type StaffInvitationInput = { email: string; name: string; role: HumanStaffRole; isLead: boolean };

/**
 * Создаёт приглашение сотрудника одной транзакцией вместе с записью аудита.
 * Прежние неиспользованные приглашения на тот же адрес отменяются: действует только последняя ссылка.
 *
 * resetUserId задан при сбросе доступа: в той же транзакции у сотрудника удаляются пароль и второй фактор
 * и завершаются все сессии (ТЗ 14.3). Новый пароль он задаст по ссылке.
 */
export async function createStaffInvitation(
  actor: Actor,
  input: StaffInvitationInput,
  opts: { resetUserId?: string; ip?: string | null } = {},
): Promise<{ token: string; expiresOn: Date }> {
  const { token, hash } = newToken();
  const expiresOn = new Date(Date.now() + STAFF_INVITATION_TTL_SEC * 1000);
  await withIdentity(actor, async (tx) => {
    if (opts.resetUserId) {
      await revokeUserSessions(tx, opts.resetUserId);
      await tx.delete(authTwoFactor).where(eq(authTwoFactor.userId, opts.resetUserId));
      await tx
        .delete(authAccount)
        .where(and(eq(authAccount.userId, opts.resetUserId), eq(authAccount.providerId, CREDENTIAL)));
      await tx.update(authUser).set({ twoFactorEnabled: false, updatedAt: sql`now()` }).where(eq(authUser.id, opts.resetUserId));
    }
    await tx
      .update(invitations)
      .set({ revokedOn: new Date() })
      .where(
        and(
          isNull(invitations.orgId),
          eq(invitations.email, input.email),
          isNull(invitations.acceptedOn),
          isNull(invitations.revokedOn),
        ),
      );
    const created = await tx
      .insert(invitations)
      .values({
        email: input.email,
        name: input.name,
        role: input.role,
        isLead: input.isLead,
        tokenHash: hash,
        invitedBy: 'userId' in actor ? actor.userId : null,
        expiresOn,
      })
      .returning({ invitationId: invitations.invitationId });
    await writeAudit(tx, {
      action: opts.resetUserId ? 'staff.reset' : 'staff.invited',
      objectType: opts.resetUserId ? 'staff' : 'invitation',
      objectId: opts.resetUserId ?? created[0]?.invitationId,
      diff: { role: input.role, isLead: input.isLead },
      ip: opts.ip,
    });
  });
  return { token, expiresOn };
}

/** Действующее приглашение сотрудника по хешу токена. */
export async function findStaffInvitation(tokenHash: string): Promise<{ email: string; name: string | null } | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ email: invitations.email, name: invitations.name })
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.orgId),
          isNull(invitations.acceptedOn),
          isNull(invitations.revokedOn),
          gt(invitations.expiresOn, new Date()),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Принимает приглашение сотрудника: учётная запись, пароль, строка сотрудника и запись аудита
 * создаются одной транзакцией. Пароль приходит уже хешем.
 */
export async function acceptStaffInvitationTx(input: {
  tokenHash: string;
  name: string;
  passwordHash: string;
}): Promise<{ userId: string }> {
  return withIdentity({ type: 'system', job: 'identity.staff.accept' }, async (tx) => {
    const found = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, input.tokenHash),
          isNull(invitations.orgId),
          isNull(invitations.acceptedOn),
          isNull(invitations.revokedOn),
          gt(invitations.expiresOn, new Date()),
        ),
      )
      .limit(1)
      // Два одновременных нажатия не должны принять одно приглашение дважды.
      .for('update');
    const invitation = found[0];
    if (!invitation) throw new HduError('link_invalid');

    const existing = (await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, invitation.email)).limit(1))[0];
    let userId: string;
    let created = false;
    if (existing) {
      // Адрес клиента сотрудником не становится: у клиента есть членство или вход через Smartup.
      const isMember = (await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.userId, existing.id)).limit(1)).length > 0;
      const hasOtherSignIn =
        (
          await tx
            .select({ id: authAccount.id })
            .from(authAccount)
            .where(and(eq(authAccount.userId, existing.id), ne(authAccount.providerId, CREDENTIAL)))
            .limit(1)
        ).length > 0;
      const isStaff = (await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, existing.id)).limit(1)).length > 0;
      if (isMember || hasOtherSignIn || !isStaff) throw new HduError('email_taken');
      userId = existing.id;
      await tx.update(authUser).set({ name: input.name, emailVerified: true, updatedAt: new Date() }).where(eq(authUser.id, userId));
    } else {
      const inserted = await tx
        .insert(authUser)
        .values({ name: input.name, email: invitation.email, emailVerified: true })
        .returning({ id: authUser.id });
      userId = (inserted[0] as { id: string }).id;
      created = true;
    }

    // Пароль хранит библиотека входа: способ входа credential, идентификатор равен идентификатору пользователя.
    await tx.delete(authAccount).where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, CREDENTIAL)));
    await tx.insert(authAccount).values({
      accountId: userId,
      providerId: CREDENTIAL,
      userId,
      password: input.passwordHash,
      updatedAt: new Date(),
    });

    await tx
      .insert(staff)
      .values({ userId, role: invitation.role as StaffRole, isLead: invitation.isLead })
      // Повторное приглашение после сброса состояние сотрудника не трогает: заблокированный остаётся заблокированным.
      .onConflictDoUpdate({ target: staff.userId, set: { role: invitation.role as StaffRole, isLead: invitation.isLead } });
    await tx.update(invitations).set({ acceptedOn: new Date() }).where(eq(invitations.invitationId, invitation.invitationId));
    if (created)
      await writeAudit(tx, {
        action: 'staff.created',
        objectType: 'staff',
        objectId: userId,
        diff: { role: invitation.role, isLead: invitation.isLead },
      });
    return { userId };
  });
}

/** Сотрудник по адресу email. */
export async function findStaffByEmail(email: string): Promise<({ userId: string; name: string } & StaffInfo) | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ userId: staff.userId, name: authUser.name, role: staff.role, state: staff.state, isLead: staff.isLead })
      .from(staff)
      .innerJoin(authUser, eq(authUser.id, staff.userId))
      .where(eq(authUser.email, email))
      .limit(1),
  );
  return rows[0] ?? null;
}
