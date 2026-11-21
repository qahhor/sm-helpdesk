'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdrError, savePlaybook } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';

// Сохранение памятки первой линии (FR-LINE-10). Права и данные проверяет модуль hdr, итог показывается кодом в адресе.

export async function savePlaybookAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor();
  const page = `/${await getLocale()}/agent/playbooks`;
  const moduleId = String(form.get('moduleId') ?? '').trim();
  try {
    await savePlaybook(staff, { moduleId: moduleId || null, type: String(form.get('type') ?? ''), body: String(form.get('body') ?? '') });
  } catch (error) {
    if (!isHdrError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(`${page}?done=saved`);
}
