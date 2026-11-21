import 'server-only';
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Actor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authAccount, authTwoFactor, authUser, authVerification } from '../auth-schema';
import { HduError } from '../error';
import { type HumanStaffRole, type RecordState, STAFF_INVITATION_TTL_SEC, type StaffRole } from '../pref';
import { invitations, memberships, staff } from '../schema';
import { newToken } from '../tokens';
import { revokeUserSessions } from './sessions';

// Модуль hdu, слой core: сотрудники. Операции с данными под ролью hub_auth.
// Права актора проверяет слой api, политики базы страхуют от ошибки в нём.

const SYSTEM = { type: 'system', job: 'identity.staff' } as const;

const CREDENTIAL = 'credential';

export type StaffInfo = { role: StaffRole; state: RecordState; isLead: boolean };

/**
 * Сотрудник, который прошёл шаг пароля в этом браузере: по значению куки ожидания второго фактора библиотека
 * хранит пользователя в auth.verification. Нужен только журналу неудачных кодов (итоговая проверка доработки):
 * значение куки случайное, и без шага пароля его не получить. Пусто, если шаг устарел или это не сотрудник.
 */
export async function findPendingStaffUserId(identifier: string): Promise<string | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const row = (
      await tx
        .select({ userId: authVerification.value })
        .from(authVerification)
        .innerJoin(staff, eq(sql`${staff.userId}::text`, authVerification.value))
        .where(and(eq(authVerification.identifier, identifier), gt(authVerification.expiresAt, sql`now()`)))
        .limit(1)
    )[0];
    return row?.userId ?? null;
  });
}

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
 *
 * Новое приглашение на адрес действующего сотрудника отклоняется (already_member): роль меняется только
 * сменой роли с проверкой последнего администратора и записью аудита, доступ восстанавливается сбросом.
 */
export async function createStaffInvitation(
  actor: Actor,
  input: StaffInvitationInput,
  opts: { resetUserId?: string; ip?: string | null } = {},
): Promise<{ token: string; expiresOn: Date }> {
  const { token, hash } = newToken();
  const expiresOn = new Date(Date.now() + STAFF_INVITATION_TTL_SEC * 1000);
  await withIdentity(actor, async (tx) => {
    if (!opts.resetUserId) {
      const existing = await tx
        .select({ userId: staff.userId })
        .from(staff)
        .innerJoin(authUser, eq(authUser.id, staff.userId))
        .where(eq(authUser.email, input.email))
        .limit(1);
      if (existing.length > 0) throw new HduError('already_member');
    }
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
      // Ссылка после сброса роль, признак руководителя и состояние сотрудника не трогает: роль меняется
      // только сменой роли (с проверкой последнего администратора и аудитом), заблокированный остаётся заблокированным.
      .onConflictDoNothing({ target: staff.userId });
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

// --- Сотрудники в разделе "Настройки" (задача 19, FR-ADM-03). От имени администратора под ролью hub_auth ---

export type StaffListRow = {
  userId: string;
  name: string;
  email: string;
  role: StaffRole;
  isLead: boolean;
  state: RecordState;
  /** Подключён ли второй фактор. Ни секрета, ни времени кодов здесь нет. */
  hasSecondFactor: boolean;
};

/** Сотрудники-люди по имени. AI-сотрудники здесь не показываются: их токены появятся в M8b. */
export async function readStaffList(actor: Actor): Promise<StaffListRow[]> {
  const rows = await withIdentity(actor, (tx) =>
    tx
      .select({
        userId: staff.userId,
        name: authUser.name,
        email: authUser.email,
        role: staff.role,
        isLead: staff.isLead,
        state: staff.state,
        hasSecondFactor: authUser.twoFactorEnabled,
      })
      .from(staff)
      .innerJoin(authUser, eq(authUser.id, staff.userId))
      .where(ne(staff.role, 'agent_bot'))
      .orderBy(asc(authUser.name), asc(staff.userId)),
  );
  return rows.map((row) => ({ ...row, hasSecondFactor: row.hasSecondFactor === true }));
}

/** Приглашения сотрудников, которые ещё ждут ответа: не приняты, не отозваны, срок не вышел. */
export async function readPendingStaffInvitations(
  actor: Actor,
): Promise<{ invitationId: string; email: string; role: HumanStaffRole; expiresOn: Date }[]> {
  const rows = await withIdentity(actor, (tx) =>
    tx
      .select({ invitationId: invitations.invitationId, email: invitations.email, role: invitations.role, expiresOn: invitations.expiresOn })
      .from(invitations)
      .where(
        and(isNull(invitations.orgId), isNull(invitations.acceptedOn), isNull(invitations.revokedOn), gt(invitations.expiresOn, sql`now()`)),
      )
      .orderBy(desc(invitations.createdOn)),
  );
  return rows.map((row) => ({ ...row, role: row.role as HumanStaffRole }));
}

/** Сотрудник-человек для сброса доступа: адрес, имя, роль. */
export async function readStaffForReset(
  actor: Actor,
  userId: string,
): Promise<{ email: string; name: string; role: HumanStaffRole; isLead: boolean } | null> {
  const rows = await withIdentity(actor, (tx) =>
    tx
      .select({ email: authUser.email, name: authUser.name, role: staff.role, isLead: staff.isLead })
      .from(staff)
      .innerJoin(authUser, eq(authUser.id, staff.userId))
      .where(and(eq(staff.userId, userId), ne(staff.role, 'agent_bot')))
      .limit(1),
  );
  const row = rows[0];
  return row ? { ...row, role: row.role as HumanStaffRole } : null;
}

export type StaffChange = { role?: HumanStaffRole; isLead?: boolean; state?: RecordState };

/**
 * Меняет роль, признак руководителя или состояние сотрудника одной транзакцией с записью аудита.
 * Блокировка завершает все сессии сотрудника в той же транзакции. Изменение, после которого
 * не останется ни одного действующего администратора, не делается: last_admin.
 * Строки действующих администраторов блокируются первыми: два одновременных понижения не оставят портал без admin.
 */
export async function changeStaffRow(actor: Actor, userId: string, change: StaffChange): Promise<'ok' | 'not_found' | 'last_admin'> {
  return withIdentity(actor, async (tx) => {
    const admins = await tx
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.role, 'admin'), eq(staff.state, 'active')))
      .orderBy(asc(staff.userId))
      .for('update');
    const target = (
      await tx.select({ role: staff.role, isLead: staff.isLead, state: staff.state }).from(staff).where(eq(staff.userId, userId)).limit(1).for('update')
    )[0];
    if (!target || target.role === 'agent_bot') return 'not_found';
    const next = { role: change.role ?? target.role, isLead: change.isLead ?? target.isLead, state: change.state ?? target.state };
    const wasActiveAdmin = target.role === 'admin' && target.state === 'active';
    const staysActiveAdmin = next.role === 'admin' && next.state === 'active';
    if (wasActiveAdmin && !staysActiveAdmin && !admins.some((admin) => admin.userId !== userId)) return 'last_admin';

    const roleChanged = next.role !== target.role || next.isLead !== target.isLead;
    const stateChanged = next.state !== target.state;
    if (!roleChanged && !stateChanged) return 'ok';
    await tx.update(staff).set(next).where(eq(staff.userId, userId));
    if (stateChanged && next.state === 'passive') await revokeUserSessions(tx, userId);
    if (roleChanged)
      await writeAudit(tx, {
        action: 'staff.role_changed',
        objectType: 'staff',
        objectId: userId,
        diff: { from: target.role, to: next.role, isLead: next.isLead },
      });
    if (stateChanged)
      await writeAudit(tx, { action: 'staff.state_changed', objectType: 'staff', objectId: userId, diff: { from: target.state, to: next.state } });
    return 'ok';
  });
}
