import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { logEvent } from '@/lib/log';
import { listAudit, writeAudit } from '@/modules/hdc/api';
import { forgetMailTraces } from '@/modules/hdn/api/anonymize';
import { authAccount, authSession, authTwoFactor, authUser } from '../auth-schema';
import { HduError } from '../error';
import { uuidInput } from '../input';
import { contactIdentities, emailTokens, invitations, linkCodes, loginCodes, memberships, staff } from '../schema';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Модуль hdu, слой api: обезличивание учётной записи по запросу (ТЗ 14.6, решение 78: "имя и email заменяются на
// обезличенные значения, тексты обращений остаются у организации"; волна 7, T2; решение 0162). Действие
// администратора портала со свежим входом. Одной транзакцией под ролью hub_auth: имя и адрес заменены, вход закрыт
// (сессии, связи входа, второй фактор, привязки каналов, одноразовые ссылки и коды удалены), членства отключены,
// ждущие приглашения на адрес отозваны, запись user.anonymized в журнале аудита. В журнал не попадают ни прежнее
// имя, ни адрес.
//
// Следы адреса и имени вне учётной записи (проверка W7, находка R3; решение 0162) стираются сразу после фиксации,
// от имени системы, и одной транзакцией с основной быть не могут:
//   - адрес и имя в строках приглашений: сотруднику база даёт только отозвать приглашение (триггер
//     t_hdu_invitations_guard), остальное меняет система; новых прав сотруднику не давалось;
//   - очередь исходящих и входящие письма (hdn): другое подключение (hub_app), пишет только система.
// Письмо, уже стоящее в очереди, на прежний адрес не уйдёт и без этих шагов: адрес получателя берётся в момент
// отправки (hdu/core/recipients.ts), у обезличенной записи его нет. Сбой шага виден в журнале работы
// (identity.anonymize_traces_failed) и возвращается ошибкой. Обрыв процесса между фиксацией и шагом следов в журнал
// работы не попадает, поэтому идентификаторы приглашений (не адреса и не имена) лежат в записи user.anonymized
// (независимая проверка, B2): повтор действия по уже обезличенной записи читает их оттуда и дочищает приглашения и
// очередь исходящих. Входящие письма по адресу повтор не найдёт: адрес стёрт, их удаляет ночная очистка через 90 суток.
//
// Учётная запись сотрудника так не обезличивается: у сотрудника свой порядок (сброс и отключение администратором),
// его имя стоит в ответах клиентам и в журнале.

const input = z.strictObject({ userId: uuidInput });
const SYSTEM: SystemActor = { type: 'system', job: 'identity.anonymize' };

/** Обезличенный адрес: домен .invalid не доставляется никуда (RFC 2606). */
const ANON_EMAIL = /^anon-[0-9a-f-]{36}@anonymized\.invalid$/;
/**
 * Сколько идентификаторов приглашений помещается в запись журнала (предел описания изменения 4000 знаков). Больше
 * приглашений на один адрес: в записи первые 80, поле invitations хранит полное число, остальные обрыв процесса оставит.
 */
const AUDIT_INVITATION_IDS = 80;
const recordedIds = z.array(z.uuid()).max(AUDIT_INVITATION_IDS);

/**
 * Идентификаторы приглашений из записи user.anonymized: для повтора по уже обезличенной записи. Журнал читает сам
 * администратор (политика hdc_audit_log_admin_select). Записи нет (старше срока хранения журнала) или она сделана до
 * появления поля: пусто.
 */
async function recordedInvitationIds(actor: StaffContext['actor'], userId: string): Promise<string[]> {
  const { items } = await listAudit({ actor }, { from: new Date(0), action: 'user.anonymized', objectType: 'user', objectId: userId });
  const parsed = recordedIds.safeParse(items[0]?.diff?.invitationIds);
  return parsed.success ? parsed.data : [];
}

export type AnonymizeResult = { alreadyDone: boolean; name: string };

export async function anonymizeAccount(ctx: StaffContext, raw: unknown, now: Date = new Date()): Promise<AnonymizeResult> {
  const actor = ctx?.actor;
  if (actor?.type !== 'staff' || actor.staffRole !== 'admin') throw new HduError('forbidden');
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new HduError('invalid_input');
  const { userId } = parsed.data;
  const done = await withIdentity(actor, async (tx) => {
    const [user] = await tx.select({ email: authUser.email, name: authUser.name, claimedEmail: authUser.claimedEmail }).from(authUser).where(eq(authUser.id, userId)).limit(1).for('update');
    if (!user) throw new HduError('not_found');
    const [staffRow] = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, userId)).limit(1);
    if (staffRow) throw new HduError('invalid_input');
    // Повтор: учётная запись уже обезличена, второй записи журнала нет.
    if (ANON_EMAIL.test(user.email)) return { alreadyDone: true, name: user.name, addresses: [], invitationIds: [] };
    const addresses = [...new Set([user.email, user.claimedEmail].filter((value): value is string => Boolean(value)).map((value) => value.trim().toLowerCase()))];
    // Приглашения на адрес: ждущие отзываются здесь же (это право администратора), адрес и имя в строках заменит система.
    const invited = await tx
      .select({ invitationId: invitations.invitationId, acceptedOn: invitations.acceptedOn, revokedOn: invitations.revokedOn })
      .from(invitations)
      .where(inArray(invitations.email, addresses))
      .for('update');
    const open = invited.filter((row) => !row.acceptedOn && !row.revokedOn).map((row) => row.invitationId);
    if (open.length > 0) await tx.update(invitations).set({ revokedOn: now }).where(inArray(invitations.invitationId, open));
    const marker = randomUUID();
    // Имя: знак "#" и восемь знаков случайного идентификатора. Не слово ни одного языка портала: страницы
    // показывают его как есть, а где имени автора нет, пишут "коллега" на языке читателя.
    const name = `#${marker.replace(/-/g, '').slice(0, 8)}`;
    await tx
      .update(authUser)
      .set({ name, email: `anon-${marker}@anonymized.invalid`, emailVerified: false, image: null, claimedEmail: null, twoFactorEnabled: false, updatedAt: now })
      .where(eq(authUser.id, userId));
    const sessions = await tx.delete(authSession).where(eq(authSession.userId, userId)).returning({ id: authSession.id });
    const accounts = await tx.delete(authAccount).where(eq(authAccount.userId, userId)).returning({ id: authAccount.id });
    await tx.delete(authTwoFactor).where(eq(authTwoFactor.userId, userId));
    const identities = await tx.delete(contactIdentities).where(eq(contactIdentities.userId, userId)).returning({ id: contactIdentities.identityId });
    await tx.delete(emailTokens).where(eq(emailTokens.userId, userId));
    await tx.delete(linkCodes).where(eq(linkCodes.userId, userId));
    await tx.delete(loginCodes).where(eq(loginCodes.userId, userId));
    const left = await tx.update(memberships).set({ state: 'passive' }).where(eq(memberships.userId, userId)).returning({ orgId: memberships.orgId });
    await writeAudit(tx, {
      action: 'user.anonymized',
      objectType: 'user',
      objectId: userId,
      diff: {
        sessions: sessions.length,
        signIns: accounts.length,
        channels: identities.length,
        memberships: left.length,
        invitations: invited.length,
        invitationsRevoked: open.length,
        // Только идентификаторы строк: по ним повтор действия дочищает адрес и имя после обрыва процесса.
        invitationIds: invited.slice(0, AUDIT_INVITATION_IDS).map((row) => row.invitationId),
      },
    });
    return { alreadyDone: false, name, addresses, invitationIds: invited.map((row) => row.invitationId) };
  });
  const { addresses, ...result } = done;
  // Повтор: идентификаторы приглашений берутся из журнала аудита, уже после транзакции учётной записи.
  const invitationIds = done.alreadyDone ? await recordedInvitationIds(actor, userId) : done.invitationIds;
  try {
    if (invitationIds.length > 0) {
      const anonEmail = sql`'anon-' || ${invitations.invitationId}::text || '@anonymized.invalid'`;
      // Только строки, где ещё есть что стирать: повтор по очищенным строкам ничего не пишет.
      await withIdentity(SYSTEM, (tx) =>
        tx
          .update(invitations)
          .set({ email: anonEmail, name: null })
          .where(and(inArray(invitations.invitationId, invitationIds), or(isNotNull(invitations.name), ne(invitations.email, anonEmail)))),
      );
    }
    // Повтор по уже обезличенной записи адресов не знает: дочищается очередь исходящих (она ищется по пользователю).
    await forgetMailTraces(SYSTEM, { userId, addresses });
  } catch (error) {
    logEvent('error', 'identity.anonymize_traces_failed', { userId, invitationIds, error });
    throw error;
  }
  return result;
}

/**
 * Обезличенное имя учётной записи или null, если запись не обезличена или её нет. Для модулей, которые хранят снимок
 * имени (идеи): менять снимок можно только у обезличенной записи и только на её нынешнее имя.
 */
export async function anonymizedAccountName(userId: string): Promise<string | null> {
  if (!z.uuid().safeParse(userId).success) return null;
  const [user] = await withIdentity(SYSTEM, (tx) => tx.select({ email: authUser.email, name: authUser.name }).from(authUser).where(eq(authUser.id, userId)).limit(1));
  return user && ANON_EMAIL.test(user.email) ? user.name : null;
}
