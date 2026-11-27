'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdaError } from '@/modules/hda/api/agent-admin';
import { markDigestReviewed } from '@/modules/hda/api/digests';
import { requireStaffActor } from '@/modules/hdu/api';

// "Просмотрено" у сводки AI-сотрудника (веха M8b, задача 10, решение 22): любой сотрудник, от своего имени, журнал
// аудита ставит модуль hda. Итог кодом в адресе страницы.

export async function markReviewedAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const locale = await getLocale();
  const id = String(form.get('id') ?? '');
  let status = 'reviewed';
  try {
    await markDigestReviewed(staff, { id });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    status = `error-${error.code}`;
  }
  redirect(`/${locale}/agent/digests/${encodeURIComponent(id)}?status=${status}`);
}
