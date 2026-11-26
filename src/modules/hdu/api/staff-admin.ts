import 'server-only';
import * as z from 'zod';
import type { StaffActor, SystemActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { createStaffInvitation, findStaffByEmail } from '../core/staff';
import { HduError } from '../error';
import { emailInput, nameInput, parseInput, staffRoleInput } from '../input';
import type { HumanStaffRole } from '../pref';

// Управление сотрудниками: приглашение и сброс доступа (FR-ID-12, FR-ADM-03).
// Этот файл не тянет библиотеку входа: его же использует команда консоли hub.

const inviteInput = z.object({
  email: emailInput,
  name: nameInput,
  role: staffRoleInput,
  isLead: z.boolean().optional().default(false),
});
const resetInput = z.object({ email: emailInput });

/** Сотрудников заводит и сбрасывает администратор портала либо команда консоли (актор system). */
function assertCanManageStaff(actor: SystemActor | StaffActor): void {
  const allowed = actor.type === 'system' || (actor.type === 'staff' && actor.staffRole === 'admin');
  if (!allowed) throw new HduError('forbidden');
}

/**
 * Приглашает сотрудника одноразовой ссылкой на 24 часа. Пароль человек задаёт сам по ссылке:
 * через консоль и журнал пароль не проходит (решение 0015). Возвращает токен ссылки, в базе лежит его хеш.
 */
export async function inviteStaff(
  actor: SystemActor | StaffActor,
  input: unknown,
  ip: string | null = null,
): Promise<{ token: string; expiresOn: Date }> {
  assertCanManageStaff(actor);
  const data = parseInput(inviteInput, input);
  return createStaffInvitation(actor, data, { ip });
}

/**
 * Сбрасывает доступ сотрудника: пароль и второй фактор удаляются, все сессии завершаются,
 * сотрудник получает новую ссылку. Так восстанавливается доступ при потере телефона с кодами.
 */
export async function resetStaff(
  actor: SystemActor | StaffActor,
  input: unknown,
  ip: string | null = null,
): Promise<{ token: string; expiresOn: Date }> {
  assertCanManageStaff(actor);
  const { email } = parseInput(resetInput, input);
  const target = await findStaffByEmail(email);
  if (!target || target.role === 'agent_bot') throw new HduError('not_found');
  return createStaffInvitation(
    actor,
    { email, name: target.name, role: target.role as HumanStaffRole, isLead: target.isLead },
    { resetUserId: target.userId, ip },
  );
}

/**
 * Действующий администратор портала по адресу, для команды консоли (актор system). Справочники меняет только
 * администратор (политики RLS), поэтому консоль действует от его имени, и журнал аудита называет его.
 */
export async function adminActorByEmail(actor: SystemActor, email: unknown): Promise<StaffActor> {
  if (actor.type !== 'system') throw new HduError('forbidden');
  const { email: address } = parseInput(resetInput, { email });
  const found = await findStaffByEmail(address);
  if (!found || found.state !== 'active' || found.role !== 'admin') throw new HduError('not_found');
  return { type: 'staff', userId: found.userId, staffRole: 'admin' };
}

/**
 * Контекст действующего администратора для команды консоли, которая вызывает функции экранов настроек (hub seed:pilot,
 * план подготовки M9, задача 6). Человек у консоли сервера входит в неё сам, поэтому вход считается свежим: время входа
 * сейчас. Журнал аудита называет администратора с этим адресом.
 */
export async function adminContextByEmail(actor: SystemActor, email: unknown): Promise<StaffContext> {
  const admin = await adminActorByEmail(actor, email);
  const found = await findStaffByEmail(parseInput(resetInput, { email }).email);
  return { actor: admin, user: { id: admin.userId, name: found?.name ?? '', email: parseInput(resetInput, { email }).email }, isLead: false, freshAuthAt: new Date() };
}
