'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdkError } from '@/modules/hdk/api/errors';
import { saveAllowedDomains } from '@/modules/hdk/api/publish';
import { requireStaffActor } from '@/modules/hdu/api';

// Раздел "Решения" настроек (план M5, задача 4; FR-SOL-04): домены, на которые решения могут ссылаться. Права, свежий
// вход и значения проверяет модуль hdk, итог показывается кодом в адресе страницы.

export async function saveAllowedDomainsAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/knowledge`;
  let invalid: string | null = null;
  try {
    const result = await saveAllowedDomains(staff, { text: String(form.get('domains') ?? '') });
    if (!result.ok) invalid = result.invalid;
  } catch (error) {
    if (!isHdkError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(invalid === null ? `${page}?done=saved` : `${page}?error=domain&value=${encodeURIComponent(invalid)}`);
}
