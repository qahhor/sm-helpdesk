import 'server-only';
import * as z from 'zod';
import type { StaffActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { LOCALES } from '@/i18n/locales';
import { mailDelivers, queueMail, staffInvitationMail, staffResetMail } from '@/modules/hdn/api';
import {
  changeStaffRow,
  createStaffInvitation,
  readPendingStaffInvitations,
  readStaffForReset,
  readStaffList,
  type StaffListRow,
} from '../core/staff';
import { HduError } from '../error';
import { emailInput, nameInput, parseInput, staffRoleInput, uuidInput } from '../input';
import type { HumanStaffRole } from '../pref';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from './session';

// Сотрудники в разделе "Настройки" рабочего места (FR-ADM-03, решение 0019). Только admin, изменения
// только со входом не старше 15 минут, запись аудита в той же транзакции. Ссылки уходят письмом:
// администратор их не видит. Команда консоли пользуется api/staff-admin.ts: тексты писем ей не нужны.

export type StaffRow = StaffListRow & { isSelf: boolean };
export type StaffInvitationRow = { invitationId: string; email: string; role: HumanStaffRole; expiresOn: Date };

function adminOf(ctx: StaffContext, now: Date, opts: { fresh: boolean }): StaffActor {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HduError('forbidden');
  if (opts.fresh && !isFresh(ctx, now, FRESH_SIGN_IN_SEC)) throw new HduError('stale_session');
  return ctx.actor;
}

/** Ссылка задания пароля сотрудника на языке письма. */
const setupUrl = (locale: string, token: string) => {
  const url = new URL(`/${locale}/staff/setup`, getEnv().HUB_URL);
  url.searchParams.set('token', token);
  return url.toString();
};

/** Сотрудники-люди: роль, руководитель линии, состояние, подключён ли второй фактор. */
export async function listStaff(ctx: StaffContext): Promise<StaffRow[]> {
  const actor = adminOf(ctx, new Date(), { fresh: false });
  return (await readStaffList(actor)).map((row) => ({ ...row, isSelf: row.userId === ctx.user.id }));
}

/** Приглашения, которые ещё не приняты. */
export async function listStaffInvitations(ctx: StaffContext): Promise<StaffInvitationRow[]> {
  return readPendingStaffInvitations(adminOf(ctx, new Date(), { fresh: false }));
}

const inviteInput = z.object({
  email: emailInput,
  name: nameInput,
  role: staffRoleInput,
  isLead: z.boolean().optional().default(false),
  locale: z.enum(LOCALES),
});

/**
 * Приглашение сотрудника письмом (то же, что hub staff:create, но ссылка уходит приглашённому).
 * mailSent: false, если почта выключена: тогда ссылку выдаёт команда консоли.
 */
export async function inviteStaffByMail(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<{ mailSent: boolean }> {
  const actor = adminOf(ctx, now, { fresh: true });
  const { locale, ...data } = parseInput(inviteInput, input);
  const { token } = await createStaffInvitation(actor, data);
  queueMail({ to: data.email, kind: 'staff-invitation', ...staffInvitationMail(locale, { url: setupUrl(locale, token), inviterName: ctx.user.name }) });
  return { mailSent: mailDelivers() };
}

const roleInput = z.object({ userId: uuidInput, role: staffRoleInput, isLead: z.boolean().optional() });
const stateInput = z.object({ userId: uuidInput, state: z.enum(['active', 'passive']) });
const resetInput = z.object({ userId: uuidInput, locale: z.enum(LOCALES) });

function applied(result: 'ok' | 'not_found' | 'last_admin'): void {
  if (result === 'not_found') throw new HduError('not_found');
  // Без действующего администратора портал некому вести: такое изменение не делается.
  if (result === 'last_admin') throw new HduError('last_admin');
}

/** Роль и признак руководителя линии. Свою роль изменить нельзя, роль agent_bot не выдаётся. */
export async function changeStaffRole(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = adminOf(ctx, now, { fresh: true });
  const { userId, role, isLead } = parseInput(roleInput, input);
  if (userId === ctx.user.id) throw new HduError('forbidden');
  applied(await changeStaffRow(actor, userId, { role, isLead }));
}

/** Блокировка и разблокировка. Блокировка завершает все сессии сотрудника сразу. Себя заблокировать нельзя. */
export async function setStaffState(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<void> {
  const actor = adminOf(ctx, now, { fresh: true });
  const { userId, state } = parseInput(stateInput, input);
  if (userId === ctx.user.id) throw new HduError('forbidden');
  applied(await changeStaffRow(actor, userId, { state }));
}

/**
 * Сброс пароля и второго фактора: все сессии сотрудника завершаются, ссылка уходит ему письмом (ТЗ 14.3).
 * Свой доступ так не сбрасывается: администратор остался бы без входа.
 */
export async function resetStaffByMail(ctx: StaffContext, input: unknown, now: Date = new Date()): Promise<{ mailSent: boolean }> {
  const actor = adminOf(ctx, now, { fresh: true });
  const { userId, locale } = parseInput(resetInput, input);
  if (userId === ctx.user.id) throw new HduError('forbidden');
  const target = await readStaffForReset(actor, userId);
  if (!target) throw new HduError('not_found');
  const { token } = await createStaffInvitation(actor, target, { resetUserId: userId });
  queueMail({ to: target.email, kind: 'staff-reset', ...staffResetMail(locale, { url: setupUrl(locale, token) }) });
  return { mailSent: mailDelivers() };
}
