import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { authAccount, authSession, authTwoFactor, authUser } from '../auth-schema';
import { HduError } from '../error';
import { uuidInput } from '../input';
import { contactIdentities, emailTokens, linkCodes, loginCodes, memberships, staff } from '../schema';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Модуль hdu, слой api: обезличивание учётной записи по запросу (ТЗ 14.6, решение 78: "имя и email заменяются на
// обезличенные значения, тексты обращений остаются у организации"; волна 7, T2; решение 0162). Действие
// администратора портала со свежим входом. Одной транзакцией под ролью hub_auth: имя и адрес заменены, вход закрыт
// (сессии, связи входа, второй фактор, привязки каналов, одноразовые ссылки и коды удалены), членства отключены,
// запись user.anonymized в журнале аудита. В журнал не попадают ни прежнее имя, ни адрес.
//
// Учётная запись сотрудника так не обезличивается: у сотрудника свой порядок (сброс и отключение администратором),
// его имя стоит в ответах клиентам и в журнале.

const input = z.strictObject({ userId: uuidInput });

/** Обезличенный адрес: домен .invalid не доставляется никуда (RFC 2606). */
const ANON_EMAIL = /^anon-[0-9a-f-]{36}@anonymized\.invalid$/;

export type AnonymizeResult = { alreadyDone: boolean; name: string };

export async function anonymizeAccount(ctx: StaffContext, raw: unknown, now: Date = new Date()): Promise<AnonymizeResult> {
  const actor = ctx?.actor;
  if (actor?.type !== 'staff' || actor.staffRole !== 'admin') throw new HduError('forbidden');
  if (!isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new HduError('invalid_input');
  const { userId } = parsed.data;
  return withIdentity(actor, async (tx) => {
    const [user] = await tx.select({ email: authUser.email, name: authUser.name }).from(authUser).where(eq(authUser.id, userId)).limit(1).for('update');
    if (!user) throw new HduError('not_found');
    const [staffRow] = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.userId, userId)).limit(1);
    if (staffRow) throw new HduError('invalid_input');
    // Повтор: учётная запись уже обезличена, второй записи журнала нет.
    if (ANON_EMAIL.test(user.email)) return { alreadyDone: true, name: user.name };
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
      diff: { sessions: sessions.length, signIns: accounts.length, channels: identities.length, memberships: left.length },
    });
    return { alreadyDone: false, name };
  });
}
