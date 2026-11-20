'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';
import {
  changeMemberRole,
  inviteMember,
  isHduError,
  requireStaffActor,
  revokeInvitation,
  setMemberState,
  type StaffContext,
} from '@/modules/hdu/api';

// Действия карточки организации в рабочем месте. Организацию сотрудник называет сам (из адреса страницы),
// права проверяет модуль: care и admin, смена роли со свежим входом.

async function run(formData: FormData, action: (staff: StaffContext, orgId: string) => Promise<void>, done: string): Promise<never> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const orgId = z.uuid().safeParse(formData.get('orgId'));
  if (!orgId.success) redirect(`/${locale}/agent/organizations`);
  const page = `/${locale}/agent/organizations/${orgId.data}`;
  try {
    await action(staff, orgId.data);
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

/** Смена роли участника (FR-ID-13): только care и admin, вход не старше 15 минут. */
export async function changeRoleAction(formData: FormData): Promise<void> {
  await run(formData, (staff, orgId) => changeMemberRole(staff, { orgId, userId: formData.get('userId'), role: formData.get('role') }), 'roleChanged');
}

/** Отключить или включить участника (пункт 12 таблицы решений M1). */
export async function setMemberStateStaffAction(formData: FormData): Promise<void> {
  const state = formData.get('state');
  await run(formData, (staff, orgId) => setMemberState({ ctx: staff, orgId }, { userId: formData.get('userId'), state }), state === 'active' ? 'enabled' : 'disabled');
}

/** Приглашение в организацию клиента от имени сотрудника. */
export async function inviteStaffAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  await run(
    formData,
    async (staff, orgId) => {
      await inviteMember({ ctx: staff, orgId }, { email: formData.get('email'), role: formData.get('role'), locale });
    },
    'invited',
  );
}

/** Отзыв ждущего приглашения. */
export async function revokeStaffAction(formData: FormData): Promise<void> {
  await run(formData, (staff, orgId) => revokeInvitation({ ctx: staff, orgId }, formData.get('invitationId')), 'revoked');
}
