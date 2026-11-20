'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { inviteMember, isHduError, requireClientActor, revokeInvitation, setMemberState } from '@/modules/hdu/api';

// Действия страницы организации. Организация берётся из актора клиента, а не из формы:
// поле организации в форме схема модуля отбросила бы.

async function run(action: () => Promise<void>, done: string): Promise<never> {
  const locale = await getLocale();
  try {
    await action();
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`/${locale}/org?error=${error.code}`);
  }
  redirect(`/${locale}/org?done=${done}`);
}

/** Приглашение коллеги в свою организацию (FR-ID-08). */
export async function inviteMemberAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const locale = await getLocale();
  await run(async () => {
    await inviteMember({ ctx: client }, { email: formData.get('email'), role: formData.get('role'), locale });
  }, 'invited');
}

/** Отзыв ждущего приглашения. */
export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  await run(() => revokeInvitation({ ctx: client }, formData.get('invitationId')), 'revoked');
}

/** Отключить или снова включить участника (пункт 12 таблицы решений M1). */
export async function setMemberStateAction(formData: FormData): Promise<void> {
  const client = await requireClientActor();
  const state = formData.get('state');
  await run(() => setMemberState({ ctx: client }, { userId: formData.get('userId'), state }), state === 'active' ? 'enabled' : 'disabled');
}
