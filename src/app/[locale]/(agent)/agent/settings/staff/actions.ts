'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import {
  changeStaffRole,
  inviteStaffByMail,
  isHduError,
  requireStaffActor,
  resetStaffByMail,
  setStaffState,
  type StaffContext,
} from '@/modules/hdu/api';

// Действия раздела "Сотрудники" (FR-ADM-03). Права, свежесть входа и запреты (себя, последнего
// администратора) проверяет модуль. Итог показывается кодом в адресе страницы.

const KNOWN_ERRORS = new Set(['invalid_input', 'stale_session', 'forbidden', 'not_found']);

async function run(action: (staff: StaffContext, locale: string) => Promise<string>): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  const page = `/${locale}/agent/settings/staff`;
  let done: string;
  try {
    done = await action(staff, locale);
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`${page}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${page}?done=${done}`);
}

/** Приглашение письмом: ссылка администратору не показывается. */
export async function inviteStaffAction(formData: FormData): Promise<void> {
  await run(async (staff, locale) => {
    const input = { email: formData.get('email'), name: formData.get('name'), role: formData.get('role'), isLead: formData.get('isLead') === 'on', locale };
    return (await inviteStaffByMail(staff, input)).mailSent ? 'invited' : 'invitedNoMail';
  });
}

/** Роль и признак руководителя линии. */
export async function changeStaffRoleAction(formData: FormData): Promise<void> {
  await run(async (staff) => {
    await changeStaffRole(staff, { userId: formData.get('userId'), role: formData.get('role'), isLead: formData.get('isLead') === 'on' });
    return 'roleChanged';
  });
}

/** Блокировка после подтверждения и разблокировка. */
export async function setStaffStateAction(formData: FormData): Promise<void> {
  await run(async (staff) => {
    const state = formData.get('state');
    await setStaffState(staff, { userId: formData.get('userId'), state });
    return state === 'passive' ? 'blocked' : 'unblocked';
  });
}

/** Сброс пароля и второго фактора после подтверждения: ссылка уходит сотруднику письмом. */
export async function resetStaffAction(formData: FormData): Promise<void> {
  await run(async (staff, locale) => ((await resetStaffByMail(staff, { userId: formData.get('userId'), locale })).mailSent ? 'reset' : 'resetNoMail'));
}
